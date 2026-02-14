const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Fail fast if required env vars are missing
const missing = [];
if (!supabaseUrl) missing.push('SUPABASE_URL');
if (!supabaseAnonKey) missing.push('SUPABASE_ANON_KEY');
if (!supabaseServiceKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');

if (missing.length > 0) {
    throw new Error(`Missing required Supabase environment variables: ${missing.join(', ')}`);
}

// Base client for general requests (respects RLS)
const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Admin client for backend operations (bypasses RLS)
const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
        autoRefreshToken: false,
        persistSession: false,
    },
});

module.exports = { supabase, supabaseAdmin };
