const express = require('express')
const router = express.Router()
const { processarMensagem } = require('./processarMensagem')
const { processarStatusEntrega } = require('./processarStatus')

// Middleware: valida token secreto enviado pela Evolution API
function validarWebhookSecret(req, res, next) {
  const tokenRaw = req.headers['apikey'] || req.query.token || ''
  const token = tokenRaw.split('/')[0]

  if (token !== process.env.WEBHOOK_SECRET) {
    console.warn('Webhook recusado: token inválido')
    return res.status(401).json({ erro: 'Token inválido' })
  }
  next()
}

// POST /webhook/whatsapp/:clinicaId
// A Evolution API envia para esta URL configurada por instância
router.post('/whatsapp/:clinicaId', validarWebhookSecret, async (req, res) => {
  const { clinicaId } = req.params
  const payload = req.body

  // Responder imediatamente para a Evolution API não tentar reenviar
  res.json({ recebido: true })

  // Processar de forma assíncrona
  try {
    const evento = payload?.event || payload?.type

    if (evento === 'messages.upsert' || evento === 'messages.new') {
      await processarMensagem(clinicaId, payload)
    } else if (evento === 'messages.update') {
      await processarStatusEntrega(clinicaId, payload)
    }
    // Outros eventos: connection.update, qrcode.updated — ignorar por ora
  } catch (err) {
    console.error('Erro ao processar webhook:', err)
  }
})

module.exports = router
