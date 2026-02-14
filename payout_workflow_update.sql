-- ============================================
-- ADD DELIVERY STATUS TO DRAWS
-- ============================================

ALTER TABLE draws ADD COLUMN IF NOT EXISTS is_delivered BOOLEAN DEFAULT FALSE;
ALTER TABLE draws ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
ALTER TABLE draws ADD COLUMN IF NOT EXISTS delivery_proof_url TEXT;

CREATE INDEX IF NOT EXISTS idx_draws_is_delivered ON draws(is_delivered);

-- ============================================
-- WITHDRAWAL REQUESTS SYSTEM (for Admin Review)
-- ============================================

CREATE TABLE IF NOT EXISTS withdrawal_requests (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    vendor_id UUID REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
    transaction_id UUID REFERENCES transactions(id), -- Link to the 'withdrawal' transaction
    amount DECIMAL(15, 2) NOT NULL,
    bank_code TEXT NOT NULL,
    account_number TEXT NOT NULL,
    account_name TEXT NOT NULL,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'processing')),
    draw_id UUID REFERENCES draws(id), -- Associated draw if applicable (one request per draw payout)
    admin_notes TEXT,
    processed_at TIMESTAMPTZ,
    processed_by UUID REFERENCES profiles(id),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_vendor_id ON withdrawal_requests(vendor_id);
CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_status ON withdrawal_requests(status);
CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_draw_id ON withdrawal_requests(draw_id);

-- Add payout_request_id to transactions metadata or as a column
-- For now we use metadata.payout_request_id
