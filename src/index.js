require('dotenv').config()
const express = require('express')
const cors = require('cors')
const webhookRouter = require('./webhook/router')
const apiRouter = require('./api/router')
const { iniciarWorkers } = require('./queue/workers')

const app = express()

app.use(cors())
app.use(express.json({ limit: '10mb' }))

// Health check
app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }))

// Rotas do webhook WhatsApp
app.use('/webhook', webhookRouter)

// Rotas da API para o frontend
app.use('/api', apiRouter)

// Iniciar workers das filas (automações, follow-up)
iniciarWorkers()

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`OdontoFlow backend rodando na porta ${PORT}`)
})
