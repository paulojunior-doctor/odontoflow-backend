# OdontoFlow Backend

Servidor Node.js que recebe mensagens do WhatsApp via Evolution API,
alimenta o CRM no Supabase e executa automações de follow-up.

## Estrutura

```
src/
├── index.js                  # Entry point Express
├── utils/
│   └── supabase.js           # Client Supabase (service role)
├── webhook/
│   ├── router.js             # Rotas e validação de token
│   ├── processarMensagem.js  # Lógica principal (contato, conversa, CRM)
│   └── processarStatus.js    # Atualização de status de entrega
├── services/
│   ├── tagger.js             # Tagueamento automático por palavras-chave
│   └── whatsapp.js           # Envio de mensagens via Evolution API
└── queue/
    ├── enfileirar.js         # BullMQ queues e helpers
    └── workers.js            # Workers de automações e follow-up
```

## Setup local

### 1. Instalar dependências
```bash
npm install
```

### 2. Configurar variáveis de ambiente
```bash
cp .env.example .env
# Editar .env com suas credenciais do Supabase e Evolution API
```

### 3. Rodar com Docker Compose (recomendado)
```bash
docker-compose up -d
```

Isso sobe: Evolution API (porta 8080), Redis (6379) e o Backend (3000).

### 4. Conectar WhatsApp
Acesse http://localhost:8080 no navegador.
Crie uma instância com o nome da sua clínica e escaneie o QR Code.

### 5. Configurar webhook na Evolution API
O Docker Compose já configura o webhook global automaticamente.
Se precisar configurar manualmente:
```
POST http://localhost:8080/webhook/set/{instancia}
{
  "url": "http://seu-backend.com/webhook/whatsapp/{clinicaId}",
  "webhook_by_events": true,
  "events": ["messages.upsert", "messages.update"]
}
```

## Deploy no Railway

1. Criar projeto no Railway
2. Adicionar serviços: este repositório (backend), Redis (plugin)
3. Copiar as variáveis do .env para as variáveis de ambiente do Railway
4. O Railway detecta o Dockerfile automaticamente

## Fluxo de uma mensagem

```
WhatsApp do paciente
      ↓
Evolution API (recebe, normaliza)
      ↓
POST /webhook/whatsapp/{clinicaId}
      ↓
validarWebhookSecret()
      ↓
processarMensagem()
  ├── normalizarPayload()        — extrai telefone, texto, tipo
  ├── buscarCanal()              — qual número recebeu
  ├── upsertContato()            — criar ou atualizar paciente
  ├── upsertConversa()           — abrir ou retomar thread
  ├── salvarMensagem()           — gravar no banco (idempotente)
  ├── detectarTags()             — "clareamento" → tag Clareamento
  ├── criarCardPipeline()        — primeiro contato → coluna "Novo lead"
  └── enfileirarAutomacoes()     — disparar regras (boas-vindas, etc.)
        ↓
   BullMQ worker
     ├── enviar template de boas-vindas (imediato)
     └── agendar follow-up em 2h se sem resposta
```
