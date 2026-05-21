const supabase = require('../utils/supabase')
const { detectarTags } = require('../services/tagger')
const { enfileirarAutomacoes } = require('../queue/enfileirar')

/**
 * Ponto de entrada principal para cada mensagem recebida via WhatsApp.
 * Fluxo:
 *   1. Normalizar payload da Evolution API
 *   2. Buscar o canal configurado para esta clínica
 *   3. Upsert do contato (criar se novo, atualizar ultima_interacao)
 *   4. Upsert da conversa (uma conversa por contato/canal)
 *   5. Salvar a mensagem
 *   6. Tagueamento automático por palavras-chave
 *   7. Criar card no pipeline se for primeiro contato
 *   8. Disparar automações na fila
 */
async function processarMensagem(clinicaId, payload) {
  const msg = normalizarPayload(payload)
  if (!msg) return // mensagem de sistema, ignorar

  console.log(`[webhook] Nova mensagem de ${msg.telefone} para clínica ${clinicaId}`)

  // 1. Buscar canal pelo número de destino
  const canal = await buscarCanal(clinicaId, msg.numeroDestino)
  if (!canal) {
    console.warn(`[webhook] Canal não encontrado para ${msg.numeroDestino}`)
    return
  }

  // 2. Upsert do contato
  const contato = await upsertContato(clinicaId, msg)

  // 3. Upsert da conversa
  const { conversa, isPrimeiraConversa } = await upsertConversa(
    clinicaId, canal.id, contato.id
  )

  // 4. Salvar mensagem (idempotente por wa_message_id)
  await salvarMensagem(clinicaId, conversa.id, msg)

  // 5. Tagueamento automático
  const tagsDetectadas = await detectarTags(clinicaId, contato.id, msg.texto)

  // 6. Criar card no pipeline se for o primeiro contato
  if (isPrimeiraConversa) {
    await criarCardPipeline(clinicaId, contato, conversa.id)
  }

  // 7. Disparar automações na fila BullMQ
  await enfileirarAutomacoes({
    tipo: 'nova_mensagem',
    clinicaId,
    contato,
    conversaId: conversa.id,
    isPrimeiraConversa,
    tagsDetectadas,
    texto: msg.texto,
  })
}

// =============================================================
// Normaliza o payload da Evolution API para um objeto simples
// =============================================================
function normalizarPayload(payload) {
  try {
    // A Evolution API envolve a mensagem em data.message
    const data = payload?.data || payload
    const messageType = data?.messageType || data?.type

    // Ignorar mensagens enviadas pelo próprio sistema
    if (data?.key?.fromMe) return null
    // Ignorar mensagens de grupos
    if (data?.key?.remoteJid?.includes('@g.us')) return null

    const telefone = limparTelefone(data?.key?.remoteJid)
    const numeroDestino = limparTelefone(data?.instance || payload?.instance)
    const waMessageId = data?.key?.id

    // Extrair conteúdo conforme o tipo
    let tipo = 'texto'
    let texto = null
    let midiaUrl = null
    let midiaTipoMime = null

    if (messageType === 'conversation' || messageType === 'extendedTextMessage') {
      tipo = 'texto'
      texto = data?.message?.conversation
        || data?.message?.extendedTextMessage?.text
        || ''
    } else if (messageType === 'imageMessage') {
      tipo = 'imagem'
      midiaTipoMime = data?.message?.imageMessage?.mimetype
      texto = data?.message?.imageMessage?.caption || null
    } else if (messageType === 'audioMessage' || messageType === 'pttMessage') {
      tipo = 'audio'
      midiaTipoMime = 'audio/ogg'
    } else if (messageType === 'videoMessage') {
      tipo = 'video'
      midiaTipoMime = data?.message?.videoMessage?.mimetype
      texto = data?.message?.videoMessage?.caption || null
    } else if (messageType === 'documentMessage') {
      tipo = 'documento'
      midiaTipoMime = data?.message?.documentMessage?.mimetype
      texto = data?.message?.documentMessage?.title || null
    } else {
      // Tipo não tratado — salvar como texto genérico
      tipo = 'texto'
      texto = '[Mensagem não suportada]'
    }

    const pushName = data?.pushName || data?.verifiedBizName || null

    return {
      waMessageId,
      telefone,
      numeroDestino,
      pushName,   // nome do contato conforme o WhatsApp deles
      tipo,
      texto,
      midiaUrl,
      midiaTipoMime,
      timestamp: data?.messageTimestamp
        ? new Date(data.messageTimestamp * 1000).toISOString()
        : new Date().toISOString(),
    }
  } catch (err) {
    console.error('[normalizar] Erro ao normalizar payload:', err)
    return null
  }
}

function limparTelefone(jid) {
  if (!jid) return null
  // Remove sufixo @s.whatsapp.net ou @c.us e mantém só o número
  return jid.replace(/@.+$/, '').replace(/[^0-9+]/g, '')
}

// =============================================================
// Busca o canal pelo número de destino
// =============================================================
async function buscarCanal(clinicaId, numeroDestino) {
  const { data } = await supabase
    .from('canais_whatsapp')
    .select('id, nome, numero')
    .eq('clinica_id', clinicaId)
    .eq('status', 'conectado')
    .limit(1)
    .maybeSingle()

  return data
}

// =============================================================
// Upsert do contato — cria se não existir, atualiza se já existe
// =============================================================
async function upsertContato(clinicaId, msg) {
  // Tentar buscar por telefone
  const { data: existente } = await supabase
    .from('contatos')
    .select('*')
    .eq('clinica_id', clinicaId)
    .eq('telefone', msg.telefone)
    .maybeSingle()

  if (existente) {
    // Atualizar nome se antes era nulo e agora temos o pushName
    const atualizacoes = { ultima_interacao: new Date().toISOString() }
    if (!existente.nome && msg.pushName) atualizacoes.nome = msg.pushName

    await supabase
      .from('contatos')
      .update(atualizacoes)
      .eq('id', existente.id)

    return { ...existente, ...atualizacoes }
  }

  // Criar novo contato
  const { data: novo, error } = await supabase
    .from('contatos')
    .insert({
      clinica_id: clinicaId,
      telefone: msg.telefone,
      nome: msg.pushName,
      origem: 'whatsapp',
      tipo: 'lead',
      ultima_interacao: new Date().toISOString(),
    })
    .select()
    .single()

  if (error) throw new Error(`Erro ao criar contato: ${error.message}`)
  console.log(`[contato] Novo contato criado: ${novo.id}`)
  return novo
}

// =============================================================
// Upsert da conversa — uma por contato/canal, reabre se resolvida
// =============================================================
async function upsertConversa(clinicaId, canalId, contatoId) {
  // Buscar conversa aberta ou em atendimento
  const { data: existente } = await supabase
    .from('conversas')
    .select('*')
    .eq('clinica_id', clinicaId)
    .eq('canal_id', canalId)
    .eq('contato_id', contatoId)
    .in('status', ['aberta', 'em_atendimento', 'aguardando'])
    .order('criado_em', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (existente) {
    return { conversa: existente, isPrimeiraConversa: false }
  }

  // Criar nova conversa (ou reabrir se era resolvida)
  const { data: nova, error } = await supabase
    .from('conversas')
    .insert({
      clinica_id: clinicaId,
      canal_id: canalId,
      contato_id: contatoId,
      status: 'aberta',
      lida: false,
    })
    .select()
    .single()

  if (error) throw new Error(`Erro ao criar conversa: ${error.message}`)
  console.log(`[conversa] Nova conversa criada: ${nova.id}`)
  return { conversa: nova, isPrimeiraConversa: true }
}

// =============================================================
// Salvar mensagem — idempotente por wa_message_id
// =============================================================
async function salvarMensagem(clinicaId, conversaId, msg) {
  // Evitar duplicatas (Evolution API pode reenviar)
  if (msg.waMessageId) {
    const { data: dup } = await supabase
      .from('mensagens')
      .select('id')
      .eq('wa_message_id', msg.waMessageId)
      .maybeSingle()
    if (dup) return dup
  }

  const { data, error } = await supabase
    .from('mensagens')
    .insert({
      conversa_id: conversaId,
      clinica_id: clinicaId,
      direcao: 'entrada',
      tipo: msg.tipo,
      conteudo: msg.texto,
      midia_url: msg.midiaUrl,
      midia_tipo_mime: msg.midiaTipoMime,
      wa_message_id: msg.waMessageId,
      wa_timestamp: msg.timestamp,
      status_entrega: 'entregue',
    })
    .select()
    .single()

  if (error) throw new Error(`Erro ao salvar mensagem: ${error.message}`)
  return data
}

// =============================================================
// Criar card no pipeline na coluna "Novo lead"
// =============================================================
async function criarCardPipeline(clinicaId, contato, conversaId) {
  // Buscar a primeira coluna (Novo lead)
  const { data: coluna } = await supabase
    .from('pipeline_colunas')
    .select('id')
    .eq('clinica_id', clinicaId)
    .order('ordem', { ascending: true })
    .limit(1)
    .single()

  if (!coluna) return

  // Verificar se já existe card para este contato
  const { data: cardExistente } = await supabase
    .from('pipeline_cards')
    .select('id')
    .eq('clinica_id', clinicaId)
    .eq('contato_id', contato.id)
    .eq('arquivado', false)
    .maybeSingle()

  if (cardExistente) return

  await supabase.from('pipeline_cards').insert({
    clinica_id: clinicaId,
    coluna_id: coluna.id,
    contato_id: contato.id,
    conversa_id: conversaId,
    titulo: contato.nome || contato.telefone,
    prioridade: 'normal',
  })

  console.log(`[pipeline] Card criado para contato ${contato.id}`)
}

module.exports = { processarMensagem }
