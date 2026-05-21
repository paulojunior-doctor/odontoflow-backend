/**
 * Serviço para enviar mensagens via Evolution API.
 * Todas as saídas do sistema passam por aqui.
 */
async function enviarMensagem({ instancia, telefone, texto }) {
  const url = `${process.env.EVOLUTION_API_URL}/message/sendText/${instancia}`

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': process.env.EVOLUTION_API_KEY,
    },
    body: JSON.stringify({
      number: telefone,
      textMessage: { text: texto },
      options: {
        delay: 1200,       // delay humanizado em ms
        presence: 'composing', // mostra "digitando..."
      },
    }),
  })

  if (!res.ok) {
    const corpo = await res.text()
    throw new Error(`Evolution API erro ${res.status}: ${corpo}`)
  }

  const data = await res.json()
  return data?.key?.id || null // retorna wa_message_id
}

async function enviarTemplate({ instancia, telefone, template, variaveis }) {
  // Substituir {{variavel}} no template
  let texto = template
  for (const [chave, valor] of Object.entries(variaveis || {})) {
    texto = texto.replaceAll(`{{${chave}}}`, valor)
  }
  return enviarMensagem({ instancia, telefone, texto })
}

module.exports = { enviarMensagem, enviarTemplate }
