const { Queue } = require('bullmq')
const IORedis = require('ioredis')

const connection = new IORedis(process.env.REDIS_URL, {
  maxRetriesPerRequest: null, // obrigatório para BullMQ
})

// Fila principal de automações
const filaAutomacoes = new Queue('automacoes', { connection })

// Fila de follow-ups agendados no tempo
const filaFollowUp = new Queue('follow-up', { connection })

/**
 * Enfileira automações baseadas em um evento.
 * O worker vai buscar no banco quais automações estão ativas
 * para este tipo de evento e executar cada uma.
 */
async function enfileirarAutomacoes(evento) {
  await filaAutomacoes.add('processar', evento, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
  })
}

/**
 * Enfileira um follow-up para ser enviado após N minutos.
 * Usado pelas automações de "sem resposta em 2h", etc.
 */
async function enfileirarFollowUp({ clinicaId, contatoId, conversaId, templateId, delayMinutos }) {
  await filaFollowUp.add(
    'enviar',
    { clinicaId, contatoId, conversaId, templateId },
    {
      delay: delayMinutos * 60 * 1000,
      jobId: `followup-${conversaId}-${templateId}`, // evita duplicatas
      attempts: 3,
      backoff: { type: 'fixed', delay: 30000 },
    }
  )
  console.log(`[fila] Follow-up agendado em ${delayMinutos}min para conversa ${conversaId}`)
}

/**
 * Cancela follow-up pendente (ex: cliente respondeu antes do prazo)
 */
async function cancelarFollowUp({ conversaId, templateId }) {
  const jobId = `followup-${conversaId}-${templateId}`
  const job = await filaFollowUp.getJob(jobId)
  if (job) {
    await job.remove()
    console.log(`[fila] Follow-up ${jobId} cancelado`)
  }
}

module.exports = {
  connection,
  filaAutomacoes,
  filaFollowUp,
  enfileirarAutomacoes,
  enfileirarFollowUp,
  cancelarFollowUp,
}
