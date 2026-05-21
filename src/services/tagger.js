const supabase = require('../utils/supabase')

/**
 * Detecta palavras-chave no texto da mensagem e aplica tags automaticamente.
 * As tags e suas palavras-chave são configuradas no banco (tabela tags),
 * então a clínica pode personalizar sem tocar no código.
 */
async function detectarTags(clinicaId, contatoId, texto) {
  if (!texto || texto.trim().length === 0) return []

  const textoNormalizado = texto
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove acentos
    .replace(/[^a-z0-9\s]/g, ' ')

  // Buscar tags automáticas da clínica
  const { data: tags } = await supabase
    .from('tags')
    .select('id, nome, palavras_chave')
    .eq('clinica_id', clinicaId)
    .eq('automatica', true)
    .not('palavras_chave', 'is', null)

  if (!tags || tags.length === 0) return []

  const tagsDetectadas = []

  for (const tag of tags) {
    if (!tag.palavras_chave?.length) continue

    const encontrou = tag.palavras_chave.some(palavra => {
      const palavraNorm = palavra
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
      return textoNormalizado.includes(palavraNorm)
    })

    if (encontrou) {
      tagsDetectadas.push(tag)
    }
  }

  if (tagsDetectadas.length === 0) return []

  // Aplicar tags no contato (ignorar duplicatas via ON CONFLICT)
  const inserts = tagsDetectadas.map(tag => ({
    contato_id: contatoId,
    tag_id: tag.id,
  }))

  await supabase
    .from('contato_tags')
    .upsert(inserts, { onConflict: 'contato_id,tag_id', ignoreDuplicates: true })

  // Se detectou interesse (procedimento), atualizar no contato
  const tagProcedimento = tagsDetectadas.find(t =>
    ['Clareamento','Implante','Ortodontia','Facetas','Limpeza'].includes(t.nome)
  )
  if (tagProcedimento) {
    await supabase
      .from('contatos')
      .update({ interesse: tagProcedimento.nome })
      .eq('id', contatoId)
      .is('interesse', null) // só atualiza se ainda não tinha interesse
  }

  console.log(`[tagger] Tags aplicadas: ${tagsDetectadas.map(t => t.nome).join(', ')}`)
  return tagsDetectadas
}

module.exports = { detectarTags }
