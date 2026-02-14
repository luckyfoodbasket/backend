-- ============================================
-- LUCKYBASKET MASTER DATABASE SCHEMA
-- Complete consolidated SQL for all tables, functions, and policies
-- Run this in Supabase SQL Editor (Fresh Database)
-- ============================================
-- 
-- EXECUTION ORDER:
-- 1. Core Tables (profiles, wallets, virtual_accounts, transactions)
-- 2. Platform Settings
-- 3. Vendor Applications
-- 4. Draws & Tickets
-- 5. Notifications
-- 6. Referrals
-- 7. Draw Audit Log
-- 8. Functions (triggers, RPC functions)
-- 9. RLS Policies
-- 10. Storage Buckets
-- ============================================

-- ============================================
-- SECTION 1: CORE USER TABLES
-- ============================================

-- 1.1 PROFILES TABLE
-- Linked to Supabase Auth users
CREATE TABLE IF NOT EXISTS profiles (
    id UUID REFERENCES auth.users ON DELETE CASCADE PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    full_name TEXT,
    phone TEXT,
    avatar_url TEXT,
    role TEXT DEFAULT 'user' CHECK (role IN ('user', 'vendor', 'admin')),
    is_verified BOOLEAN DEFAULT FALSE,
    referral_code TEXT UNIQUE,
    referred_by UUID REFERENCES profiles(id),
    verification_token TEXT,
    verification_expires TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_profiles_referral_code ON profiles(referral_code);
CREATE INDEX IF NOT EXISTS idx_profiles_verification_token ON profiles(verification_token);

-- 1.2 WALLETS TABLE
CREATE TABLE IF NOT EXISTS wallets (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES profiles(id) ON DELETE CASCADE UNIQUE NOT NULL,
    balance DECIMAL(15, 2) DEFAULT 0.00 CHECK (balance >= 0),
    vendor_balance DECIMAL(15, 2) DEFAULT 0.00 CHECK (vendor_balance >= 0),
    currency TEXT DEFAULT 'NGN',
    is_locked BOOLEAN DEFAULT FALSE,
    lock_reason TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wallets_user_id ON wallets(user_id);
CREATE INDEX IF NOT EXISTS idx_wallets_vendor_balance ON wallets(vendor_balance) WHERE vendor_balance > 0;

-- 1.3 VIRTUAL_ACCOUNTS TABLE (for VDA/Bank Accounts)
CREATE TABLE IF NOT EXISTS virtual_accounts (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
    wallet_id UUID REFERENCES wallets(id) ON DELETE CASCADE NOT NULL,
    provider TEXT NOT NULL CHECK (provider IN ('monnify', 'paystack', 'flutterwave')),
    account_reference TEXT NOT NULL,
    account_number TEXT NOT NULL,
    account_name TEXT,
    bank_name TEXT NOT NULL,
    bank_code TEXT,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(provider, account_reference)
);

CREATE INDEX IF NOT EXISTS idx_virtual_accounts_user_id ON virtual_accounts(user_id);

-- 1.4 TRANSACTIONS TABLE
CREATE TABLE IF NOT EXISTS transactions (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
    wallet_id UUID REFERENCES wallets(id) ON DELETE SET NULL,
    type TEXT NOT NULL CHECK (type IN ('topup', 'purchase', 'refund', 'withdrawal', 'bonus', 'reversal', 'transfer', 'payout')),
    amount DECIMAL(15, 2) NOT NULL,
    fee DECIMAL(15, 2) DEFAULT 0.00,
    balance_before DECIMAL(15, 2),
    balance_after DECIMAL(15, 2),
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed', 'reversed')),
    reference TEXT UNIQUE NOT NULL,
    external_reference TEXT,
    payment_method TEXT,
    provider TEXT,
    description TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_reference ON transactions(reference);
CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(type);
CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);

-- ============================================
-- SECTION 2: PLATFORM SETTINGS
-- ============================================

CREATE TABLE IF NOT EXISTS platform_settings (
    id INTEGER PRIMARY KEY DEFAULT 1,
    settings JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_by UUID REFERENCES profiles(id),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT only_one_row CHECK (id = 1)
);

-- Insert default settings
INSERT INTO platform_settings (id, settings, updated_at)
VALUES (1, '{
    "platformFee": 15,
    "referralBonus": 500,
    "referralBonusReferee": 500,
    "referralPercentage": 5,
    "minTicketPrice": 500,
    "maxTicketPrice": 5000,
    "defaultTicketPrice": 1000,
    "maxTicketsPerDraw": 1000,
    "minTicketsPerDraw": 10,
    "autoDrawOnFull": true,
    "maxTicketsPerPurchase": 50,
    "minDeposit": 1000,
    "minWithdrawal": 5000,
    "withdrawalFee": 100,
    "minBundlePrice": 50000,
    "maxBundlePrice": 500000
}'::jsonb, NOW())
ON CONFLICT (id) DO NOTHING;

-- ============================================
-- SECTION 3: VENDOR APPLICATIONS
-- ============================================

CREATE TABLE IF NOT EXISTS vendor_applications (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES profiles(id) ON DELETE CASCADE UNIQUE NOT NULL,
    business_name TEXT NOT NULL,
    business_address TEXT NOT NULL,
    phone TEXT NOT NULL,
    id_proof_url TEXT,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    rejection_reason TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vendor_applications_user_id ON vendor_applications(user_id);
CREATE INDEX IF NOT EXISTS idx_vendor_applications_status ON vendor_applications(status);

-- ============================================
-- SECTION 4: DRAWS & TICKETS
-- ============================================

-- 4.1 Ticket Number Sequence
CREATE SEQUENCE IF NOT EXISTS ticket_number_seq START 100001;

-- 4.2 DRAWS TABLE
CREATE TABLE IF NOT EXISTS draws (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    vendor_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    description TEXT,
    image_url TEXT,
    images JSONB DEFAULT '[]',
    video_url TEXT,
    category TEXT,
    items JSONB DEFAULT '[]',
    bundle_value DECIMAL(15, 2) NOT NULL,
    ticket_price DECIMAL(15, 2),
    total_tickets INTEGER,
    sold_tickets INTEGER DEFAULT 0,
    draw_type TEXT DEFAULT 'slot_complete' CHECK (draw_type IN ('slot_complete', 'timer', 'scheduled')),
    status TEXT DEFAULT 'pending_review' CHECK (status IN ('pending_review', 'active', 'completed', 'cancelled', 'rejected')),
    draw_date TIMESTAMPTZ,
    winner_id UUID REFERENCES profiles(id),
    winning_ticket_id UUID,
    is_featured BOOLEAN DEFAULT false,
    storage_instructions TEXT,
    delivery_notes TEXT,
    admin_notes TEXT,
    rejection_reason TEXT,
    submitted_at TIMESTAMPTZ,
    reviewed_at TIMESTAMPTZ,
    reviewed_by UUID REFERENCES profiles(id),
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_draws_status ON draws(status);
CREATE INDEX IF NOT EXISTS idx_draws_vendor_id ON draws(vendor_id);
CREATE INDEX IF NOT EXISTS idx_draws_is_featured ON draws(is_featured) WHERE is_featured = true;
CREATE INDEX IF NOT EXISTS idx_draws_draw_date ON draws(draw_date);

-- 4.3 TICKETS TABLE
CREATE TABLE IF NOT EXISTS tickets (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    draw_id UUID REFERENCES draws(id) ON DELETE CASCADE NOT NULL,
    user_id UUID REFERENCES profiles(id) ON DELETE SET NULL NOT NULL,
    ticket_number TEXT NOT NULL,
    transaction_id UUID REFERENCES transactions(id),
    is_winner BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(draw_id, ticket_number)
);

CREATE INDEX IF NOT EXISTS idx_tickets_draw_id ON tickets(draw_id);
CREATE INDEX IF NOT EXISTS idx_tickets_user_id ON tickets(user_id);
CREATE INDEX IF NOT EXISTS idx_tickets_is_winner ON tickets(is_winner) WHERE is_winner = true;

-- ============================================
-- SECTION 5: DRAW AUDIT LOG
-- ============================================

CREATE TABLE IF NOT EXISTS draw_audit_log (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    draw_id UUID REFERENCES draws(id) ON DELETE CASCADE NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN ('tickets_purchased', 'draw_executed', 'winner_selected')),
    actor_id UUID REFERENCES profiles(id),
    details JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_draw_id ON draw_audit_log(draw_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_event_type ON draw_audit_log(event_type);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON draw_audit_log(created_at DESC);

-- ============================================
-- SECTION 6: NOTIFICATIONS
-- ============================================

CREATE TABLE IF NOT EXISTS notifications (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_id UUID REFERENCES profiles(id) ON DELETE CASCADE NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('welcome', 'referral', 'wallet', 'ticket', 'win', 'draw', 'kyc', 'system')),
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    action_url TEXT,
    metadata JSONB DEFAULT '{}',
    is_read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_is_read ON notifications(user_id, is_read);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(user_id, created_at DESC);

-- ============================================
-- SECTION 7: REFERRALS (LEGACY - kept for compatibility)
-- ============================================

CREATE TABLE IF NOT EXISTS referrals (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    referrer_id UUID REFERENCES profiles(id) ON DELETE SET NULL NOT NULL,
    referred_id UUID REFERENCES profiles(id) ON DELETE SET NULL NOT NULL,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'expired')),
    referrer_bonus DECIMAL(15, 2) DEFAULT 0,
    referred_bonus DECIMAL(15, 2) DEFAULT 0,
    first_purchase_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(referred_id)
);

CREATE INDEX IF NOT EXISTS idx_referrals_referrer_id ON referrals(referrer_id);
CREATE INDEX IF NOT EXISTS idx_referrals_referred_id ON referrals(referred_id);
CREATE INDEX IF NOT EXISTS idx_referrals_status ON referrals(status);

-- ============================================
-- SECTION 8: TRIGGERS & FUNCTIONS
-- ============================================

-- 8.1 Auto-create profile when user signs up
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
DECLARE
    new_referral_code TEXT;
BEGIN
    -- Generate a unique referral code (8 chars uppercase alphanumeric)
    new_referral_code := UPPER(SUBSTRING(MD5(NEW.id::text || NOW()::text) FROM 1 FOR 8));
    
    INSERT INTO public.profiles (id, email, full_name, phone, referral_code)
    VALUES (
        NEW.id,
        NEW.email,
        NEW.raw_user_meta_data->>'full_name',
        NEW.raw_user_meta_data->>'phone',
        new_referral_code
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 8.2 Auto-create wallet when profile is created
CREATE OR REPLACE FUNCTION public.handle_new_profile()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.wallets (user_id, balance, vendor_balance)
    VALUES (NEW.id, 0, 0);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_profile_created ON public.profiles;
CREATE TRIGGER on_profile_created
    AFTER INSERT ON public.profiles
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_profile();

-- 8.3 Execute Draw Function (winner selection & vendor payout)
CREATE OR REPLACE FUNCTION public.execute_draw(_draw_id UUID)
RETURNS JSONB AS $$
DECLARE
    v_draw RECORD;
    v_winning_ticket RECORD;
    v_random_seed UUID;
    v_all_ticket_ids UUID[];
    v_total_participants INTEGER;
    v_vendor_wallet RECORD;
    v_platform_fee_percent DECIMAL;
    v_total_revenue DECIMAL;
    v_vendor_payout DECIMAL;
    v_platform_fee DECIMAL;
    v_prev_vendor_bal DECIMAL;
    v_new_vendor_bal DECIMAL;
    v_settings JSONB;
BEGIN
    -- Get the draw (lock it to prevent concurrent execution)
    SELECT * INTO v_draw FROM draws WHERE id = _draw_id FOR UPDATE;

    IF v_draw IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', 'Draw not found');
    END IF;

    IF v_draw.status = 'completed' THEN
        RETURN jsonb_build_object('success', false, 'message', 'Draw already completed');
    END IF;

    IF v_draw.status = 'cancelled' THEN
        RETURN jsonb_build_object('success', false, 'message', 'Draw is cancelled');
    END IF;

    -- Check if there are any tickets
    IF v_draw.sold_tickets = 0 THEN
        RETURN jsonb_build_object('success', false, 'message', 'No tickets sold for this draw');
    END IF;

    -- Generate random seed for audit trail
    v_random_seed := gen_random_uuid();

    -- Get all ticket IDs for this draw
    SELECT ARRAY_AGG(id ORDER BY created_at) INTO v_all_ticket_ids FROM tickets WHERE draw_id = _draw_id;

    -- Count unique participants
    SELECT COUNT(DISTINCT user_id) INTO v_total_participants FROM tickets WHERE draw_id = _draw_id;

    -- Select random winner using cryptographic randomness
    SELECT * INTO v_winning_ticket
    FROM tickets
    WHERE draw_id = _draw_id
    ORDER BY md5(id::text || v_random_seed::text)
    LIMIT 1;

    IF v_winning_ticket IS NULL THEN
        RETURN jsonb_build_object('success', false, 'message', 'No tickets found for this draw');
    END IF;

    -- Calculate Vendor Payout & Platform Fees
    BEGIN
        SELECT settings INTO v_settings FROM platform_settings WHERE id = 1;
        v_platform_fee_percent := COALESCE((v_settings->>'platformFee')::decimal, 15.0);
    EXCEPTION
        WHEN OTHERS THEN
            v_platform_fee_percent := 15.0;
    END;

    v_total_revenue := v_draw.sold_tickets * v_draw.ticket_price;
    v_platform_fee := v_total_revenue * (v_platform_fee_percent / 100);
    v_vendor_payout := v_total_revenue - v_platform_fee;

    -- Credit Vendor Wallet (vendor_balance column)
    SELECT * INTO v_vendor_wallet FROM wallets WHERE user_id = v_draw.vendor_id FOR UPDATE;
    IF FOUND THEN
        v_prev_vendor_bal := v_vendor_wallet.vendor_balance;
        v_new_vendor_bal := v_prev_vendor_bal + v_vendor_payout;

        UPDATE wallets
        SET vendor_balance = v_new_vendor_bal, updated_at = NOW()
        WHERE id = v_vendor_wallet.id;

        -- Transaction record for vendor earnings
        INSERT INTO transactions (
            user_id, wallet_id, type, amount, status, reference,
            description, balance_before, balance_after, completed_at, metadata
        ) VALUES (
            v_draw.vendor_id,
            v_vendor_wallet.id,
            'payout',
            v_vendor_payout,
            'completed',
            'PAYOUT_' || REPLACE(gen_random_uuid()::text, '-', ''),
            'Draw payout for: ' || v_draw.title || ' (after ' || v_platform_fee_percent || '% platform fee)',
            v_prev_vendor_bal,
            v_new_vendor_bal,
            NOW(),
            jsonb_build_object(
                'draw_id', _draw_id,
                'total_revenue', v_total_revenue,
                'platform_fee', v_platform_fee,
                'platform_fee_percent', v_platform_fee_percent,
                'vendor_payout', v_vendor_payout
            )
        );
    END IF;

    -- Mark winning ticket
    UPDATE tickets SET is_winner = TRUE WHERE id = v_winning_ticket.id;

    -- Update draw with winner info
    UPDATE draws SET
        status = 'completed',
        winner_id = v_winning_ticket.user_id,
        winning_ticket_id = v_winning_ticket.id,
        completed_at = NOW(),
        updated_at = NOW()
    WHERE id = _draw_id;

    -- Insert audit log for draw execution
    INSERT INTO draw_audit_log (draw_id, event_type, details)
    VALUES (_draw_id, 'draw_executed', jsonb_build_object(
        'total_tickets', v_draw.sold_tickets,
        'total_participants', v_total_participants,
        'random_seed', v_random_seed::text,
        'all_ticket_ids', to_jsonb(v_all_ticket_ids),
        'execution_timestamp', NOW(),
        'total_revenue', v_total_revenue,
        'platform_fee', v_platform_fee,
        'platform_fee_percent', v_platform_fee_percent,
        'vendor_payout', v_vendor_payout
    ));

    -- Insert audit log for winner selection
    INSERT INTO draw_audit_log (draw_id, event_type, actor_id, details)
    VALUES (_draw_id, 'winner_selected', v_winning_ticket.user_id, jsonb_build_object(
        'winner_id', v_winning_ticket.user_id,
        'winning_ticket_id', v_winning_ticket.id,
        'winning_ticket_number', v_winning_ticket.ticket_number,
        'random_seed', v_random_seed::text,
        'selection_method', 'MD5 hash-based ordering with CSPRNG seed',
        'total_tickets_in_draw', v_draw.sold_tickets,
        'total_participants', v_total_participants
    ));

    RETURN jsonb_build_object(
        'success', true,
        'winner_id', v_winning_ticket.user_id,
        'winning_ticket_id', v_winning_ticket.id,
        'winning_ticket_number', v_winning_ticket.ticket_number,
        'total_tickets', v_draw.sold_tickets,
        'total_participants', v_total_participants,
        'random_seed', v_random_seed::text,
        'total_revenue', v_total_revenue,
        'platform_fee', v_platform_fee,
        'vendor_payout', v_vendor_payout
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 8.4 Buy Tickets V2 Function (atomic multi-ticket purchase with referral bonuses)
CREATE OR REPLACE FUNCTION public.buy_tickets_v2(
    _user_id UUID,
    _draw_id UUID,
    _quantity INTEGER
)
RETURNS JSONB AS $$
DECLARE
    v_draw RECORD;
    v_wallet RECORD;
    v_profile RECORD;
    v_total_cost DECIMAL;
    v_prev_balance DECIMAL;
    v_new_balance DECIMAL;
    v_transaction_id UUID;
    v_tickets JSONB := '[]'::jsonb;
    v_ticket_id UUID;
    v_ticket_number TEXT;
    v_new_sold INTEGER;
    v_draw_completed BOOLEAN := FALSE;
    v_draw_result JSONB;
    v_max_tickets_per_purchase INTEGER := 50;
    v_referrer_bonus DECIMAL := 0;
    v_referee_bonus DECIMAL := 0;
    i INTEGER;
BEGIN
    -- Get max tickets per purchase from settings
    BEGIN
        SELECT (settings->>'maxTicketsPerPurchase')::INTEGER INTO v_max_tickets_per_purchase
        FROM platform_settings WHERE id = 1;

        IF v_max_tickets_per_purchase IS NULL THEN
            v_max_tickets_per_purchase := 50;
        END IF;
    EXCEPTION
        WHEN OTHERS THEN
            v_max_tickets_per_purchase := 50;
    END;

    -- Validate quantity
    IF _quantity < 1 OR _quantity > v_max_tickets_per_purchase THEN
        RETURN jsonb_build_object('success', false, 'error',
            'Quantity must be between 1 and ' || v_max_tickets_per_purchase);
    END IF;

    -- Lock and fetch draw
    SELECT * INTO v_draw FROM draws WHERE id = _draw_id FOR UPDATE;

    IF v_draw IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Draw not found');
    END IF;

    IF v_draw.status != 'active' THEN
        RETURN jsonb_build_object('success', false, 'error', 'This draw is no longer active');
    END IF;

    -- Prevent vendors from buying their own bundle tickets
    IF v_draw.vendor_id = _user_id THEN
        RETURN jsonb_build_object('success', false, 'error', 'Vendors cannot participate in their own bundle');
    END IF;

    IF v_draw.sold_tickets + _quantity > v_draw.total_tickets THEN
        RETURN jsonb_build_object('success', false, 'error',
            'Not enough tickets available. Only ' || (v_draw.total_tickets - v_draw.sold_tickets) || ' remaining');
    END IF;

    -- Calculate total cost
    v_total_cost := v_draw.ticket_price * _quantity;

    -- Lock and fetch wallet
    SELECT * INTO v_wallet FROM wallets WHERE user_id = _user_id FOR UPDATE;

    IF v_wallet IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'Wallet not found');
    END IF;

    IF v_wallet.balance < v_total_cost THEN
        RETURN jsonb_build_object('success', false, 'error',
            'Insufficient wallet balance. You need ₦' || v_total_cost || ' but have ₦' || v_wallet.balance);
    END IF;

    IF v_wallet.is_locked THEN
        RETURN jsonb_build_object('success', false, 'error', 'Wallet is locked. Please contact support.');
    END IF;

    -- Deduct wallet balance
    v_prev_balance := v_wallet.balance;
    v_new_balance := v_prev_balance - v_total_cost;

    UPDATE wallets SET balance = v_new_balance, updated_at = NOW() WHERE id = v_wallet.id;

    -- Create transaction record
    v_transaction_id := gen_random_uuid();

    INSERT INTO transactions (
        id, user_id, wallet_id, type, amount, status, reference,
        description, balance_before, balance_after, completed_at,
        metadata
    ) VALUES (
        v_transaction_id,
        _user_id,
        v_wallet.id,
        'purchase',
        v_total_cost,
        'completed',
        'TKT_' || UPPER(REPLACE(gen_random_uuid()::text, '-', '')),
        _quantity || ' ticket(s) for draw: ' || v_draw.title,
        v_prev_balance,
        v_new_balance,
        NOW(),
        jsonb_build_object(
            'draw_id', _draw_id,
            'quantity', _quantity,
            'ticket_price', v_draw.ticket_price,
            'draw_title', v_draw.title
        )
    );

    -- Generate tickets
    FOR i IN 1.._quantity LOOP
        v_ticket_id := gen_random_uuid();
        -- Note: using a manual sequence or simpler generation if nextval fails
        v_ticket_number := 'LB-' || LPAD(FLOOR(RANDOM() * 1000000)::text, 6, '0');
        
        -- Try to use sequence if exists
        BEGIN
            v_ticket_number := 'LB-' || LPAD(nextval('ticket_number_seq')::text, 6, '0');
        EXCEPTION WHEN OTHERS THEN 
            -- Fallback already set
        END;

        INSERT INTO tickets (id, draw_id, user_id, ticket_number, transaction_id, created_at)
        VALUES (v_ticket_id, _draw_id, _user_id, v_ticket_number, v_transaction_id, NOW());

        v_tickets := v_tickets || jsonb_build_object(
            'id', v_ticket_id,
            'ticket_number', v_ticket_number
        );
    END LOOP;

    -- Update draw sold_tickets
    v_new_sold := v_draw.sold_tickets + _quantity;
    UPDATE draws SET sold_tickets = v_new_sold, updated_at = NOW() WHERE id = _draw_id;

    -- Insert audit log for ticket purchase
    INSERT INTO draw_audit_log (draw_id, event_type, actor_id, details)
    VALUES (_draw_id, 'tickets_purchased', _user_id, jsonb_build_object(
        'quantity', _quantity,
        'total_cost', v_total_cost,
        'ticket_numbers', v_tickets,
        'transaction_id', v_transaction_id,
        'new_total_sold', v_new_sold
    ));
    -- Process referral bonus if this is the user's first ticket purchase
    BEGIN
        SELECT * INTO v_profile FROM profiles WHERE id = _user_id;

        IF v_profile.referred_by IS NOT NULL THEN
            -- Check if this is the first ticket purchase
            IF NOT EXISTS (
                SELECT 1 FROM transactions
                WHERE user_id = _user_id
                AND type = 'purchase'
                AND status = 'completed'
                AND id != v_transaction_id
            ) THEN
                -- Sub-block for referral specific variables
                DECLARE
                    v_referrer_wallet_id UUID;
                    v_referee_wallet_id UUID;
                BEGIN
                    -- Fetch settings from platform_settings
                    SELECT
                        COALESCE((settings->>'referralBonus')::DECIMAL, 500),
                        COALESCE((settings->>'referralBonusReferee')::DECIMAL, 500)
                    INTO v_referrer_bonus, v_referee_bonus
                    FROM platform_settings WHERE id = 1;

                    -- Get wallet IDs
                    SELECT id INTO v_referrer_wallet_id FROM wallets WHERE user_id = v_profile.referred_by;
                    v_referee_wallet_id := v_wallet.id;

                    -- Credit referrer
                    IF v_referrer_wallet_id IS NOT NULL AND v_referrer_bonus > 0 THEN
                        UPDATE wallets
                        SET balance = balance + v_referrer_bonus, updated_at = NOW()
                        WHERE id = v_referrer_wallet_id;

                        INSERT INTO transactions (
                            user_id, wallet_id, type, amount, status, description,
                            reference, completed_at, metadata
                        ) VALUES (
                            v_profile.referred_by,
                            v_referrer_wallet_id,
                            'bonus',
                            v_referrer_bonus,
                            'completed',
                            'Referral bonus for ' || v_profile.full_name || '''s first purchase',
                            'REF_' || UPPER(REPLACE(gen_random_uuid()::text, '-', '')),
                            NOW(),
                            jsonb_build_object('referee_id', _user_id, 'trigger', 'first_purchase')
                        );
                    END IF;

                    -- Credit referee (the new user)
                    IF v_referee_bonus > 0 THEN
                        UPDATE wallets
                        SET balance = balance + v_referee_bonus, updated_at = NOW()
                        WHERE id = v_referee_wallet_id;

                        INSERT INTO transactions (
                            user_id, wallet_id, type, amount, status, description,
                            reference, completed_at, metadata
                        ) VALUES (
                            _user_id,
                            v_referee_wallet_id,
                            'bonus',
                            v_referee_bonus,
                            'completed',
                            'Welcome bonus for your first purchase',
                            'WELCOME_' || UPPER(REPLACE(gen_random_uuid()::text, '-', '')),
                            NOW(),
                            jsonb_build_object('trigger', 'first_purchase')
                        );

                        -- Update current transaction's "new balance" return value to include the bonus
                        v_new_balance := v_new_balance + v_referee_bonus;
                    END IF;

                    -- Update the referral record to completed
                    UPDATE referrals
                    SET 
                        status = 'completed',
                        referrer_bonus = v_referrer_bonus,
                        referred_bonus = v_referee_bonus,
                        first_purchase_at = NOW(),
                        updated_at = NOW()
                    WHERE referred_id = _user_id;

                EXCEPTION
                    WHEN OTHERS THEN
                        RAISE WARNING 'Failed to process referral bonus: %', SQLERRM;
                END;
            END IF;
        END IF;
    EXCEPTION
        WHEN OTHERS THEN
            RAISE WARNING 'Failed to check/process referral: %', SQLERRM;
    END;

    -- Check if draw is complete (slot_complete type)
    IF v_draw.draw_type = 'slot_complete' AND v_new_sold >= v_draw.total_tickets THEN
        v_draw_result := public.execute_draw(_draw_id);
        v_draw_completed := TRUE;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'tickets', v_tickets,
        'total_cost', v_total_cost,
        'new_balance', v_new_balance,
        'draw_completed', v_draw_completed,
        'draw_result', COALESCE(v_draw_result, '{}'::jsonb),
        'transaction_id', v_transaction_id,
        'referral_bonus_credited', (v_profile.referred_by IS NOT NULL AND v_referrer_bonus > 0),
        'bonus_referrer', v_referrer_bonus,
        'bonus_referee', v_referee_bonus,
        'referrer_id', v_profile.referred_by
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- SECTION 9: ROW LEVEL SECURITY (RLS) POLICIES
-- ============================================

-- 9.1 PROFILES
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own profile" ON profiles;
DROP POLICY IF EXISTS "Users can update own profile" ON profiles;
DROP POLICY IF EXISTS "Enable insert for authenticated users" ON profiles;

CREATE POLICY "Users can view own profile" ON profiles
    FOR SELECT USING (auth.uid() = id);

CREATE POLICY "Users can update own profile" ON profiles
    FOR UPDATE USING (auth.uid() = id);

CREATE POLICY "Enable insert for authenticated users" ON profiles
    FOR INSERT WITH CHECK (auth.uid() = id);

-- 9.2 WALLETS
ALTER TABLE wallets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own wallet" ON wallets;
DROP POLICY IF EXISTS "Service role can manage wallets" ON wallets;

CREATE POLICY "Users can view own wallet" ON wallets
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Service role can manage wallets" ON wallets
    FOR ALL USING (true);

-- 9.3 VIRTUAL_ACCOUNTS
ALTER TABLE virtual_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own virtual accounts" ON virtual_accounts;
DROP POLICY IF EXISTS "Service role can manage virtual accounts" ON virtual_accounts;

CREATE POLICY "Users can view own virtual accounts" ON virtual_accounts
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Service role can manage virtual accounts" ON virtual_accounts
    FOR ALL USING (true);

-- 9.4 TRANSACTIONS
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own transactions" ON transactions;
DROP POLICY IF EXISTS "Service role can manage transactions" ON transactions;

CREATE POLICY "Users can view own transactions" ON transactions
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Service role can manage transactions" ON transactions
    FOR ALL USING (true);

-- 9.5 PLATFORM_SETTINGS
ALTER TABLE platform_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can read settings" ON platform_settings;
DROP POLICY IF EXISTS "Authenticated can update settings" ON platform_settings;

CREATE POLICY "Anyone can read settings" ON platform_settings
    FOR SELECT USING (true);

CREATE POLICY "Authenticated can update settings" ON platform_settings
    FOR ALL USING (true) WITH CHECK (true);

-- 9.6 VENDOR_APPLICATIONS
ALTER TABLE vendor_applications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own application" ON vendor_applications;
DROP POLICY IF EXISTS "Users can insert own application" ON vendor_applications;
DROP POLICY IF EXISTS "Admins can manage all applications" ON vendor_applications;

CREATE POLICY "Users can view own application" ON vendor_applications
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own application" ON vendor_applications
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Admins can manage all applications" ON vendor_applications
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM profiles 
            WHERE profiles.id = auth.uid() 
            AND profiles.role = 'admin'
        )
    );

-- 9.7 DRAWS
ALTER TABLE draws ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can view active draws" ON draws;
DROP POLICY IF EXISTS "Anyone can view active and completed draws" ON draws;
DROP POLICY IF EXISTS "Vendors can view own draws" ON draws;
DROP POLICY IF EXISTS "Vendors can create draws" ON draws;
DROP POLICY IF EXISTS "Vendors can update own pending draws" ON draws;
DROP POLICY IF EXISTS "Service role full access on draws" ON draws;

CREATE POLICY "Anyone can view active and completed draws" ON draws
    FOR SELECT USING (status IN ('active', 'completed'));

CREATE POLICY "Vendors can view own draws" ON draws
    FOR SELECT USING (auth.uid() = vendor_id);

CREATE POLICY "Vendors can create draws" ON draws
    FOR INSERT WITH CHECK (auth.uid() = vendor_id AND status = 'pending_review');

CREATE POLICY "Vendors can update own pending draws" ON draws
    FOR UPDATE USING (auth.uid() = vendor_id AND status IN ('pending_review', 'rejected'));

CREATE POLICY "Service role full access on draws" ON draws
    FOR ALL USING (true);

-- 9.8 TICKETS
ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own tickets" ON tickets;
DROP POLICY IF EXISTS "Anyone can view winning tickets" ON tickets;
DROP POLICY IF EXISTS "Anyone can view tickets" ON tickets;
DROP POLICY IF EXISTS "Service role can manage tickets" ON tickets;
DROP POLICY IF EXISTS "Authenticated can insert tickets" ON tickets;
DROP POLICY IF EXISTS "Authenticated can update tickets" ON tickets;

CREATE POLICY "Anyone can view tickets" ON tickets
    FOR SELECT USING (true);

CREATE POLICY "Authenticated can insert tickets" ON tickets
    FOR INSERT WITH CHECK (true);

CREATE POLICY "Authenticated can update tickets" ON tickets
    FOR UPDATE USING (true) WITH CHECK (true);

-- 9.9 DRAW_AUDIT_LOG
ALTER TABLE draw_audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Anyone can view audit logs" ON draw_audit_log;
DROP POLICY IF EXISTS "Service role can manage audit logs" ON draw_audit_log;
DROP POLICY IF EXISTS "Authenticated can insert audit logs" ON draw_audit_log;
DROP POLICY IF EXISTS "Authenticated can update audit logs" ON draw_audit_log;

CREATE POLICY "Anyone can view audit logs" ON draw_audit_log
    FOR SELECT USING (true);

CREATE POLICY "Authenticated can insert audit logs" ON draw_audit_log
    FOR INSERT WITH CHECK (true);

CREATE POLICY "Authenticated can update audit logs" ON draw_audit_log
    FOR UPDATE USING (true) WITH CHECK (true);

-- 9.10 NOTIFICATIONS
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own notifications" ON notifications;
DROP POLICY IF EXISTS "Users can update own notifications" ON notifications;
DROP POLICY IF EXISTS "Users can delete own notifications" ON notifications;
DROP POLICY IF EXISTS "Service role can manage notifications" ON notifications;

CREATE POLICY "Users can view own notifications" ON notifications
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can update own notifications" ON notifications
    FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own notifications" ON notifications
    FOR DELETE USING (auth.uid() = user_id);

CREATE POLICY "Service role can manage notifications" ON notifications
    FOR ALL USING (true);

-- 9.11 REFERRALS
ALTER TABLE referrals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own referrals" ON referrals;
DROP POLICY IF EXISTS "Service role can manage referrals" ON referrals;

CREATE POLICY "Users can view own referrals" ON referrals
    FOR SELECT USING (auth.uid() = referrer_id);

CREATE POLICY "Service role can manage referrals" ON referrals
    FOR ALL USING (true);

-- ============================================
-- SECTION 10: STORAGE BUCKETS & POLICIES
-- ============================================

-- 10.1 Bundle Media Bucket
INSERT INTO storage.buckets (id, name, public) 
VALUES ('bundle-media', 'bundle-media', true)
ON CONFLICT (id) DO NOTHING;

-- Vendors can upload bundle media to their own folder
DROP POLICY IF EXISTS "Vendors can upload bundle media" ON storage.objects;
CREATE POLICY "Vendors can upload bundle media" ON storage.objects
    FOR INSERT WITH CHECK (
        bucket_id = 'bundle-media' AND
        auth.uid()::text = (storage.foldername(name))[1]
    );

-- Public can view bundle media
DROP POLICY IF EXISTS "Public can view bundle media" ON storage.objects;
CREATE POLICY "Public can view bundle media" ON storage.objects
    FOR SELECT USING (bucket_id = 'bundle-media');

-- Vendors can delete their own uploads
DROP POLICY IF EXISTS "Vendors can delete own bundle media" ON storage.objects;
CREATE POLICY "Vendors can delete own bundle media" ON storage.objects
    FOR DELETE USING (
        bucket_id = 'bundle-media' AND
        auth.uid()::text = (storage.foldername(name))[1]
    );

-- 10.2 Vendor Documents Bucket
INSERT INTO storage.buckets (id, name, public) 
VALUES ('vendor-documents', 'vendor-documents', true)
ON CONFLICT (id) DO NOTHING;

-- Allow authenticated uploads
DROP POLICY IF EXISTS "Allow authenticated uploads" ON storage.objects;
CREATE POLICY "Allow authenticated uploads" ON storage.objects
    FOR INSERT 
    TO authenticated
    WITH CHECK (bucket_id = 'vendor-documents');

-- Allow public select
DROP POLICY IF EXISTS "Allow public select" ON storage.objects;
CREATE POLICY "Allow public select" ON storage.objects
    FOR SELECT
    TO public
    USING (bucket_id = 'vendor-documents');

-- ============================================
-- MIGRATION COMPLETE!
-- ============================================
-- 
-- This master schema includes:
-- ✅ All core tables (profiles, wallets, transactions, etc.)
-- ✅ Platform settings with defaults
-- ✅ Vendor applications system
-- ✅ Draws & tickets with audit logging
-- ✅ Notifications system
-- ✅ Referral system (integrated into buy_tickets_v2)
-- ✅ Auto-triggers for profile & wallet creation
-- ✅ Execute draw function with vendor payouts
-- ✅ Buy tickets V2 with referral bonuses
-- ✅ Complete RLS policies for all tables
-- ✅ Storage buckets for media uploads
-- 
-- NOTES:
-- - Vendor earnings go to vendor_balance (view-only)
-- - Regular balance is for spending (tickets, withdrawals)
-- - Referral bonuses are credited on first ticket purchase
-- - Platform fee is deducted from vendor payouts
-- - All draw executions are audited for transparency
-- ============================================
