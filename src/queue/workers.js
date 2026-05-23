const { Worker } = require('bullmq')
const { connection, enfileirarFollowUp } = require('./enfileirar')
const supabase = require('../utils/supabase')
const { enviarTemplate } = require('../services/whatsapp')

// =============================================================
// Worker 1: Automações — executa regras de automação
// =============================================================
function criarWorkerAutomacoes() {
  return new Worker('automacoes', async (job) => {
    const evento = job.data
    const { clinicaId, tipo } = evento

    console.log(`[worker] Processando evento "${tipo}" para clínica ${clinicaId}`)

    // Buscar automações ativas que respondem a este gatilho
    const { data: automacoes } = await supabase
      .from('automacoes')
      .select('*')
      .eq('clinica_id', clinicaId)
      .eq('ativa', true)
      .eq('gatilho_tipo', tipo)
    console.log(`[debug] Buscando automacoes: clinicaId=${clinicaId} tipo=${tipo} encontradas=${automacoes?.length || 0}`)
      if (!automacoes?.length) return

    for (const auto of automacoes) {
      try {
        await executarAcao(auto, evento)

        // Registrar execução
        await supabase.from('automacao_execucoes').insert({
          automacao_id: auto.id,
          clinica_id: clinicaId,
          contato_id: evento.contato?.id,
          conversa_id: evento.conversaId,
          status: 'executado',
        })

        // Incrementar contador
        await supabase.rpc('incrementar_execucoes', { auto_id: auto.id })
      } catch (err) {
        console.error(`[worker] Falha na automação ${auto.id}:`, err.message)
        await supabase.from('automacao_execucoes').insert({
          automacao_id: auto.id,
          clinica_id: clinicaId,
          status: 'falhou',
          erro: err.message,
        })
      }
    }
  }, { connection, concurrency: 5 })
}

// =============================================================
// Worker 2: Follow-up — envia mensagem após delay
// =============================================================
function criarWorkerFollowUp() {
  return new Worker('follow-up', async (job) => {
    const { clinicaId, contatoId, conversaId, templateId } = job.data

    // Verificar se a conversa ainda está aberta (cliente pode ter respondido)
    const { data: conversa } = await supabase
      .from('conversas')
      .select('status, contato_id')
      .eq('id', conversaId)
      .single()

    if (!conversa || conversa.status === 'resolvida') {
      console.log(`[follow-up] Conversa ${conversaId} já resolvida, pulando`)
      return
    }

    // Buscar contato e canal
    const { data: contato } = await supabase
      .from('contatos')
      .select('telefone, nome')
      .eq('id', contatoId)
      .single()

    const { data: canal } = await supabase
      .from('canais_whatsapp')
      .select('evolution_instance')
      .eq('clinica_id', clinicaId)
      .eq('status', 'conectado')
      .limit(1)
      .single()

    if (!contato || !canal) return

    // Buscar template
    const { data: template } = await supabase
      .from('templates_mensagem')
      .select('conteudo')
      .eq('id', templateId)
      .single()

    if (!template) return

    // Enviar via Evolution API
    const waId = await enviarTemplate({
      instancia: canal.evolution_instance,
      telefone: contato.telefone,
      template: template.conteudo,
      variaveis: { nome: contato.nome?.split(' ')[0] || 'você' },
    })

    // Salvar a mensagem enviada no histórico
    await supabase.from('mensagens').insert({
      conversa_id: conversaId,
      clinica_id: clinicaId,
      direcao: 'saida',
      tipo: 'texto',
      conteudo: template.conteudo,
      wa_message_id: waId,
      automatico: true,
      template_id: templateId,
      status_entrega: 'enviado',
    })

    console.log(`[follow-up] Enviado para ${contato.telefone}`)
  }, { connection, concurrency: 10 })
}

// =============================================================
// Executa a ação de uma automação
// =============================================================
async function executarAcao(automacao, evento) {
  const { acao_tipo, acao_config, delay_minutos, clinica_id } = automacao

  switch (acao_tipo) {

    // Enviar template de mensagem (imediato ou com delay)
    case 'enviar_template': {
      if (delay_minutos > 0) {
        await enfileirarFollowUp({
          clinicaId: clinica_id,
          contatoId: evento.contato.id,
          conversaId: evento.conversaId,
          templateId: acao_config.template_id,
          delayMinutos: delay_minutos,
        })
      } else {
        const { data: canal } = await supabase
          .from('canais_whatsapp')
          .select('evolution_instance')
          .eq('clinica_id', clinica_id)
          .eq('status', 'conectado')
          .limit(1)
          .single()

        const { data: template } = await supabase
          .from('templates_mensagem')
          .select('conteudo')
          .eq('id', acao_config.template_id)
          .single()

        if (canal && template) {
          await enviarTemplate({
            instancia: canal.evolution_instance,
            telefone: evento.contato.telefone,
            template: template.conteudo,
            variaveis: { nome: evento.contato.nome?.split(' ')[0] || 'você' },
          })
        }
      }
      break
    }

    // Mover card para outra coluna do pipeline
    case 'mover_pipeline': {
      await supabase
        .from('pipeline_cards')
        .update({ coluna_id: acao_config.coluna_id })
        .eq('clinica_id', clinica_id)
        .eq('contato_id', evento.contato.id)
        .eq('arquivado', false)
      break
    }

    // Aplicar tag ao contato
    case 'aplicar_tag': {
      await supabase
        .from('contato_tags')
        .upsert(
          { contato_id: evento.contato.id, tag_id: acao_config.tag_id },
          { onConflict: 'contato_id,tag_id', ignoreDuplicates: true }
        )
      break
    }

    // Atribuir conversa a um usuário da equipe
    case 'atribuir_usuario': {
      await supabase
        .from('conversas')
        .update({ atribuido_para: acao_config.usuario_id, status: 'em_atendimento' })
        .eq('id', evento.conversaId)
      break
    }

    default:
      console.warn(`[worker] Ação desconhecida: ${acao_tipo}`)
  }
}

// =============================================================
// Inicializar todos os workers
// =============================================================
function iniciarWorkers() {
  const wAuto = criarWorkerAutomacoes()
  const wFollowUp = criarWorkerFollowUp()

  wAuto.on('completed', job => console.log(`[worker] automação job ${job.id} ok`))
  wAuto.on('failed', (job, err) => console.error(`[worker] automação job ${job?.id} falhou:`, err.message))

  wFollowUp.on('completed', job => console.log(`[worker] follow-up job ${job.id} ok`))
  wFollowUp.on('failed', (job, err) => console.error(`[worker] follow-up job ${job?.id} falhou:`, err.message))

  console.log('Workers BullMQ iniciados: automacoes, follow-up')
  return { wAuto, wFollowUp }
}

module.exports = { iniciarWorkers }
