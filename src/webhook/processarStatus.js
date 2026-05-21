const supabase = require('../utils/supabase')

/**
 * Atualiza status de entrega de mensagens enviadas pelo sistema
 * (enviado → entregue → lido)
 */
async function processarStatusEntrega(clinicaId, payload) {
  const updates = payload?.data?.update || payload?.update || []
  if (!Array.isArray(updates)) return

  for (const item of updates) {
    const waId = item?.key?.id
    const statusRaw = item?.update?.status

    if (!waId || !statusRaw) continue

    const statusMap = {
      PENDING:   'enviando',
      SERVER_ACK: 'enviado',
      DELIVERY_ACK: 'entregue',
      READ: 'lido',
      PLAYED: 'lido',
    }

    const status = statusMap[statusRaw]
    if (!status) continue

    await supabase
      .from('mensagens')
      .update({ status_entrega: status })
      .eq('wa_message_id', waId)
      .eq('clinica_id', clinicaId)
  }
}

module.exports = { processarStatusEntrega }
