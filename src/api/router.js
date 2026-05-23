// src/api/router.js
const express = require('express')
const router = express.Router()
const supabase = require('../utils/supabase')
const { enviarMensagem, enviarTemplate } = require('../services/whatsapp')

// Middleware: valida JWT do Supabase para proteger as rotas do frontend
async function autenticar(req, res, next) {
  const auth = req.headers.authorization
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ erro: 'Não autenticado' })

  const token = auth.slice(7)
  const { data: { user }, error } = await supabase.auth.getUser(token)
  if (error || !user) return res.status(401).json({ erro: 'Token inválido' })

  // Buscar clinica_id do usuário logado
  const { data: usuario } = await supabase
    .from('usuarios')
    .select('id, clinica_id, nome, cargo')
    .eq('id', user.id)
    .single()

  if (!usuario) return res.status(403).json({ erro: 'Usuário não encontrado' })
  req.usuario = usuario
  next()
}

// =============================================================
// POST /api/mensagens — frontend envia mensagem via WhatsApp
// Body: { conversaId, texto, tipo? }
// =============================================================
router.post('/mensagens', autenticar, async (req, res) => {
  const { conversaId, texto, tipo = 'texto' } = req.body
  const { clinica_id, id: usuarioId } = req.usuario

  if (!conversaId || !texto?.trim()) {
    return res.status(400).json({ erro: 'conversaId e texto são obrigatórios' })
  }

  // Buscar conversa + contato + canal (garantindo que é da mesma clínica)
  const { data: conversa, error: errConv } = await supabase
    .from('conversas')
    .select(`
      id, status, contato_id,
      contato:contatos(telefone),
      canal:canais_whatsapp(evolution_instance, status)
    `)
    .eq('id', conversaId)
    .eq('clinica_id', clinica_id)
    .single()

  if (errConv || !conversa) return res.status(404).json({ erro: 'Conversa não encontrada' })
  if (conversa.canal?.status !== 'conectado') {
    return res.status(422).json({ erro: 'Canal WhatsApp desconectado' })
  }

  // Enviar via Evolution API
  let waMessageId = null
  try {
    waMessageId = await enviarMensagem({
      instancia: conversa.canal.evolution_instance,
      telefone: conversa.contato.telefone,
      texto: texto.trim(),
    })
  } catch (err) {
    console.error('[api] Erro ao enviar mensagem:', err.message)
    return res.status(502).json({ erro: 'Falha ao enviar pelo WhatsApp' })
  }

  // Salvar mensagem de saída no banco
  const { data: mensagem, error: errMsg } = await supabase
    .from('mensagens')
    .insert({
      conversa_id: conversaId,
      clinica_id,
      direcao: 'saida',
      tipo,
      conteudo: texto.trim(),
      wa_message_id: waMessageId,
      status_entrega: 'enviado',
      enviado_por: usuarioId,
      automatico: false,
    })
    .select()
    .single()

  if (errMsg) return res.status(500).json({ erro: 'Mensagem enviada mas não salva no banco' })

  // Atualizar status da conversa para "em_atendimento"
  if (conversa.status === 'aberta') {
    await supabase
      .from('conversas')
      .update({ status: 'em_atendimento', atribuido_para: usuarioId })
      .eq('id', conversaId)
  }

  res.json({ ok: true, mensagem })
})

// =============================================================
// POST /api/mensagens/template — enviar template pré-definido
// Body: { conversaId, templateId, variaveis? }
// =============================================================
router.post('/mensagens/template', autenticar, async (req, res) => {
  const { conversaId, templateId, variaveis = {} } = req.body
  const { clinica_id, id: usuarioId } = req.usuario

  const { data: template } = await supabase
    .from('templates_mensagem')
    .select('*')
    .eq('id', templateId)
    .eq('clinica_id', clinica_id)
    .single()

  if (!template) return res.status(404).json({ erro: 'Template não encontrado' })

  const { data: conversa } = await supabase
    .from('conversas')
    .select('contato:contatos(nome, telefone), canal:canais_whatsapp(evolution_instance, status)')
    .eq('id', conversaId)
    .eq('clinica_id', clinica_id)
    .single()

  if (!conversa || conversa.canal?.status !== 'conectado') {
    return res.status(422).json({ erro: 'Canal desconectado' })
  }

  // Mesclar variáveis automáticas + as fornecidas pelo usuário
  const varsCompletas = {
    nome: conversa.contato?.nome?.split(' ')[0] || 'você',
    ...variaveis,
  }

  const waMessageId = await enviarTemplate({
    instancia: conversa.canal.evolution_instance,
    telefone: conversa.contato.telefone,
    template: template.conteudo,
    variaveis: varsCompletas,
  })

  // Substituir variáveis no conteúdo para salvar o texto final
  let conteudoFinal = template.conteudo
  for (const [k, v] of Object.entries(varsCompletas)) {
    conteudoFinal = conteudoFinal.replaceAll(`{{${k}}}`, v)
  }

  await supabase.from('mensagens').insert({
    conversa_id: conversaId,
    clinica_id,
    direcao: 'saida',
    tipo: 'template',
    conteudo: conteudoFinal,
    wa_message_id: waMessageId,
    status_entrega: 'enviado',
    enviado_por: usuarioId,
    template_id: templateId,
    automatico: false,
  })

  res.json({ ok: true })
})

// =============================================================
// PATCH /api/conversas/:id — atualizar status, atribuição
// Body: { status?, atribuido_para? }
// =============================================================
router.patch('/conversas/:id', autenticar, async (req, res) => {
  const { id } = req.params
  const { clinica_id } = req.usuario
  const campos = {}

  if (req.body.status) campos.status = req.body.status
  if (req.body.atribuido_para !== undefined) campos.atribuido_para = req.body.atribuido_para

  if (Object.keys(campos).length === 0) return res.status(400).json({ erro: 'Nada para atualizar' })

  const { error } = await supabase
    .from('conversas')
    .update(campos)
    .eq('id', id)
    .eq('clinica_id', clinica_id)

  if (error) return res.status(500).json({ erro: error.message })
  res.json({ ok: true })
})

// =============================================================
// PATCH /api/pipeline/cards/:id — mover card entre colunas
// Body: { coluna_id }
// =============================================================
router.patch('/pipeline/cards/:id', autenticar, async (req, res) => {
  const { id } = req.params
  const { coluna_id } = req.body
  const { clinica_id, id: usuarioId } = req.usuario

  if (!coluna_id) return res.status(400).json({ erro: 'coluna_id é obrigatório' })

  // Buscar coluna origem para o histórico
  const { data: card } = await supabase
    .from('pipeline_cards')
    .select('coluna_id')
    .eq('id', id)
    .eq('clinica_id', clinica_id)
    .single()

  if (!card) return res.status(404).json({ erro: 'Card não encontrado' })

  await supabase
    .from('pipeline_cards')
    .update({ coluna_id })
    .eq('id', id)

  await supabase.from('pipeline_historico').insert({
    card_id: id,
    clinica_id,
    coluna_origem: card.coluna_id,
    coluna_destino: coluna_id,
    movido_por: usuarioId,
    automatico: false,
  })

  res.json({ ok: true })
})

// =============================================================
// GET /api/templates — listar templates da clínica
// =============================================================
router.get('/templates', autenticar, async (req, res) => {
  const { clinica_id } = req.usuario
  const { data } = await supabase
    .from('templates_mensagem')
    .select('id, nome, categoria, conteudo, variaveis')
    .eq('clinica_id', clinica_id)
    .eq('ativo', true)
    .order('categoria')

  res.json(data || [])
})

// =============================================================
// GET /api/dashboard — métricas agregadas
// =============================================================
router.get('/dashboard', autenticar, async (req, res) => {
  const { clinica_id } = req.usuario
  const agora = new Date()
  const inicioHoje = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate()).toISOString()

  const [
    { count: conversasHoje },
    { count: naoLidas },
    { count: agsHoje },
    { count: leadsAtivos },
  ] = await Promise.all([
    supabase.from('conversas').select('*', { count: 'exact', head: true })
      .eq('clinica_id', clinica_id).gte('criado_em', inicioHoje),
    supabase.from('conversas').select('*', { count: 'exact', head: true })
      .eq('clinica_id', clinica_id).eq('lida', false),
    supabase.from('agendamentos').select('*', { count: 'exact', head: true })
      .eq('clinica_id', clinica_id)
      .gte('inicio', inicioHoje)
      .lt('inicio', new Date(agora.getFullYear(), agora.getMonth(), agora.getDate() + 1).toISOString()),
    supabase.from('pipeline_cards').select('*', { count: 'exact', head: true })
      .eq('clinica_id', clinica_id).eq('arquivado', false),
  ])

  res.json({ conversasHoje, naoLidas, agsHoje, leadsAtivos })
})

// =============================================================
// POST /api/agendamentos — criar agendamento e mover card no kanban
// Body: { contatoId, inicio, fim, procedimento?, observacoes? }
// =============================================================
router.post('/agendamentos', autenticar, async (req, res) => {
  const { contatoId, inicio, fim, procedimento, observacoes } = req.body
  const { clinica_id, id: usuarioId } = req.usuario

  if (!contatoId || !inicio || !fim) {
    return res.status(400).json({ erro: 'contatoId, inicio e fim são obrigatórios' })
  }

  // Criar o agendamento
  const { data: agendamento, error } = await supabase
    .from('agendamentos')
    .insert({
      clinica_id,
      contato_id: contatoId,
      inicio,
      fim,
      procedimento,
      observacoes,
      criado_por: usuarioId,
    })
    .select()
    .single()

  if (error) return res.status(500).json({ erro: error.message })

  // Buscar coluna "Agendado" do kanban
  const { data: coluna } = await supabase
    .from('pipeline_colunas')
    .select('id')
    .eq('clinica_id', clinica_id)
    .ilike('nome', '%agendado%')
    .limit(1)
    .single()

  // Mover card do contato para coluna "Agendado"
  if (coluna) {
    const { data: card } = await supabase
      .from('pipeline_cards')
      .select('id, coluna_id')
      .eq('clinica_id', clinica_id)
      .eq('contato_id', contatoId)
      .eq('arquivado', false)
      .maybeSingle()

    if (card) {
      await supabase
        .from('pipeline_cards')
        .update({ coluna_id: coluna.id })
        .eq('id', card.id)

      await supabase.from('pipeline_historico').insert({
        card_id: card.id,
        clinica_id,
        coluna_origem: card.coluna_id,
        coluna_destino: coluna.id,
        movido_por: usuarioId,
        automatico: true,
      })
    }
  }

  res.json({ ok: true, agendamento })
})
  module.exports = router
