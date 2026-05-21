const { createClient } = require('@supabase/supabase-js')
const WebSocket = require('ws')

// Service Role bypassa RLS — seguro apenas no servidor
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: WebSocket },
  }
)

module.exports = supabase
