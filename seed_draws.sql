-- ============================================
-- SAMPLE DRAWS DATA POPULATION SCRIPT
-- ============================================
-- This script populates the draws table with realistic sample data
-- Run this script in your Supabase SQL Editor or psql

-- ============================================
-- STEP 1: Get or Create a Vendor User
-- ============================================
-- First, we need a vendor user. This will use the first user in the system
-- or you can replace this with a specific vendor_id

DO $$
DECLARE
    v_vendor_id UUID;
    v_user_id UUID;
BEGIN
    -- Try to get an existing vendor from vendor_applications
    SELECT user_id INTO v_vendor_id 
    FROM vendor_applications 
    WHERE status = 'approved' 
    LIMIT 1;
    
    -- If no approved vendor exists, use the first user in profiles
    IF v_vendor_id IS NULL THEN
        SELECT id INTO v_vendor_id 
        FROM profiles 
        WHERE role = 'vendor'
        LIMIT 1;
    END IF;
    
    -- If still no vendor, use any user
    IF v_vendor_id IS NULL THEN
        SELECT id INTO v_vendor_id 
        FROM profiles 
        LIMIT 1;
    END IF;
    
    -- Store in a temporary table for use in inserts
    CREATE TEMP TABLE IF NOT EXISTS temp_vendor (vendor_id UUID);
    DELETE FROM temp_vendor;
    INSERT INTO temp_vendor VALUES (v_vendor_id);
    
    RAISE NOTICE 'Using vendor_id: %', v_vendor_id;
END $$;

-- ============================================
-- STEP 2: Insert Sample Draws
-- ============================================

-- Active Draws (Ready for purchase)
INSERT INTO draws (
    vendor_id,
    title,
    description,
    category,
    bundle_value,
    ticket_price,
    total_tickets,
    sold_tickets,
    draw_type,
    status,
    is_featured,
    items,
    images,
    storage_instructions,
    delivery_notes,
    submitted_at,
    reviewed_at,
    created_at
)
SELECT 
    vendor_id,
    'Premium Family Food Bundle',
    'A complete family food package with rice, beans, oil, and fresh vegetables. Perfect for a family of 4-6 for a week.',
    'mixed',
    150000,
    1000,
    200,
    45,
    'slot_complete',
    'active',
    true,
    '["Rice 50kg", "Beans 25kg", "Vegetable Oil 5L", "Tomatoes 10kg", "Onions 5kg", "Fresh Pepper 2kg"]'::jsonb,
    '["https://images.unsplash.com/photo-1542838132-92c53300491e?w=800", "https://images.unsplash.com/photo-1488459716781-31db52582fe9?w=800"]'::jsonb,
    'Store rice and beans in a cool, dry place. Keep vegetables refrigerated.',
    'Delivery within 48 hours of winning. Please ensure someone is available to receive.',
    NOW() - INTERVAL '5 days',
    NOW() - INTERVAL '4 days',
    NOW() - INTERVAL '5 days'
FROM temp_vendor

UNION ALL

SELECT 
    vendor_id,
    'Fresh Vegetable Basket',
    'Farm-fresh vegetables harvested daily. Includes a variety of seasonal vegetables perfect for healthy meals.',
    'vegetables',
    75000,
    500,
    180,
    89,
    'slot_complete',
    'active',
    true,
    '["Tomatoes 5kg", "Carrots 3kg", "Cabbage 2 heads", "Spinach 2kg", "Bell Peppers 1kg", "Cucumber 2kg", "Lettuce 3 heads"]'::jsonb,
    '["https://images.unsplash.com/photo-1540420773420-3366772f4999?w=800", "https://images.unsplash.com/photo-1597362925123-77861d3fbac7?w=800"]'::jsonb,
    'Refrigerate immediately upon receipt. Best consumed within 5-7 days.',
    'Same-day delivery available for Lagos residents.',
    NOW() - INTERVAL '3 days',
    NOW() - INTERVAL '2 days',
    NOW() - INTERVAL '3 days'
FROM temp_vendor

UNION ALL

SELECT 
    vendor_id,
    'Protein Power Pack',
    'High-quality protein bundle with chicken, fish, and eggs. Perfect for fitness enthusiasts and families.',
    'protein',
    200000,
    1500,
    150,
    67,
    'slot_complete',
    'active',
    false,
    '["Frozen Chicken 10kg", "Fresh Fish 5kg", "Eggs (2 crates)", "Beef 3kg", "Turkey Wings 2kg"]'::jsonb,
    '["https://images.unsplash.com/photo-1607623814075-e51df1bdc82f?w=800", "https://images.unsplash.com/photo-1615937691194-97dbd3f3dc29?w=800"]'::jsonb,
    'Keep frozen at -18°C. Thaw in refrigerator before cooking.',
    'Delivered in insulated cooler bags to maintain freshness.',
    NOW() - INTERVAL '6 days',
    NOW() - INTERVAL '5 days',
    NOW() - INTERVAL '6 days'
FROM temp_vendor

UNION ALL

SELECT 
    vendor_id,
    'Grains & Cereals Bundle',
    'Essential grains for your pantry. Includes rice, beans, garri, and more staples.',
    'grains',
    120000,
    800,
    180,
    123,
    'slot_complete',
    'active',
    false,
    '["Rice 25kg", "Beans 10kg", "Garri 10kg", "Semovita 5kg", "Oats 2kg", "Cornflakes 1kg"]'::jsonb,
    '["https://images.unsplash.com/photo-1586201375761-83865001e31c?w=800"]'::jsonb,
    'Store in airtight containers in a cool, dry place. Protect from moisture and pests.',
    'Bulk delivery - please ensure adequate storage space.',
    NOW() - INTERVAL '4 days',
    NOW() - INTERVAL '3 days',
    NOW() - INTERVAL '4 days'
FROM temp_vendor

UNION ALL

SELECT 
    vendor_id,
    'Dairy Delight Package',
    'Fresh dairy products delivered to your doorstep. Milk, cheese, yogurt, and butter.',
    'dairy',
    90000,
    600,
    160,
    34,
    'slot_complete',
    'active',
    false,
    '["Fresh Milk 5L", "Cheddar Cheese 1kg", "Yogurt 2L", "Butter 500g", "Cream 500ml", "Eggs (1 crate)"]'::jsonb,
    '["https://images.unsplash.com/photo-1628088062854-d1870b4553da?w=800"]'::jsonb,
    'Refrigerate immediately. Consume within expiry dates printed on products.',
    'Morning delivery preferred to ensure freshness.',
    NOW() - INTERVAL '2 days',
    NOW() - INTERVAL '1 day',
    NOW() - INTERVAL '2 days'
FROM temp_vendor

UNION ALL

SELECT 
    vendor_id,
    'Tropical Fruit Basket',
    'Exotic and local fruits bursting with flavor. A healthy treat for the whole family.',
    'fruits',
    85000,
    550,
    170,
    78,
    'slot_complete',
    'active',
    true,
    '["Pineapples 3pcs", "Watermelon 1pc", "Oranges 2kg", "Bananas 2 bunches", "Apples 1kg", "Grapes 1kg", "Mangoes 2kg"]'::jsonb,
    '["https://images.unsplash.com/photo-1610832958506-aa56368176cf?w=800", "https://images.unsplash.com/photo-1619566636858-adf3ef46400b?w=800"]'::jsonb,
    'Store in a cool place. Some fruits can be refrigerated for longer shelf life.',
    'Fruits are hand-picked and quality-checked before delivery.',
    NOW() - INTERVAL '1 day',
    NOW() - INTERVAL '12 hours',
    NOW() - INTERVAL '1 day'
FROM temp_vendor

UNION ALL

SELECT 
    vendor_id,
    'Mega Family Bundle',
    'Everything you need for a month! Comprehensive food package for large families.',
    'mixed',
    350000,
    2000,
    200,
    156,
    'slot_complete',
    'active',
    true,
    '["Rice 100kg", "Beans 50kg", "Vegetable Oil 10L", "Frozen Chicken 15kg", "Fresh Fish 10kg", "Tomatoes 20kg", "Onions 10kg", "Garri 20kg", "Eggs (3 crates)", "Milk 10L"]'::jsonb,
    '["https://images.unsplash.com/photo-1542838132-92c53300491e?w=800", "https://images.unsplash.com/photo-1488459716781-31db52582fe9?w=800", "https://images.unsplash.com/photo-1540420773420-3366772f4999?w=800"]'::jsonb,
    'Requires adequate storage space. Store perishables in refrigerator/freezer immediately.',
    'Delivery in refrigerated truck. Two-person delivery team will assist with offloading.',
    NOW() - INTERVAL '7 days',
    NOW() - INTERVAL '6 days',
    NOW() - INTERVAL '7 days'
FROM temp_vendor;

-- Completed Draws (For history/reference)
INSERT INTO draws (
    vendor_id,
    title,
    description,
    category,
    bundle_value,
    ticket_price,
    total_tickets,
    sold_tickets,
    draw_type,
    status,
    is_featured,
    items,
    images,
    submitted_at,
    reviewed_at,
    completed_at,
    created_at
)
SELECT 
    vendor_id,
    'New Year Special Bundle',
    'Celebration food package that was won in our New Year draw!',
    'mixed',
    180000,
    1200,
    150,
    150,
    'slot_complete',
    'completed',
    false,
    '["Rice 50kg", "Chicken 10kg", "Fish 5kg", "Drinks 2 crates", "Vegetables Mix 10kg"]'::jsonb,
    '["https://images.unsplash.com/photo-1542838132-92c53300491e?w=800"]'::jsonb,
    NOW() - INTERVAL '30 days',
    NOW() - INTERVAL '29 days',
    NOW() - INTERVAL '20 days',
    NOW() - INTERVAL '30 days'
FROM temp_vendor

UNION ALL

SELECT 
    vendor_id,
    'Valentine Special Package',
    'Romantic dinner bundle - completed draw from Valentine season.',
    'mixed',
    95000,
    700,
    140,
    140,
    'slot_complete',
    'completed',
    false,
    '["Premium Beef 2kg", "Wine 2 bottles", "Chocolates 1kg", "Fresh Vegetables", "Dessert Items"]'::jsonb,
    '["https://images.unsplash.com/photo-1607623814075-e51df1bdc82f?w=800"]'::jsonb,
    NOW() - INTERVAL '45 days',
    NOW() - INTERVAL '44 days',
    NOW() - INTERVAL '35 days',
    NOW() - INTERVAL '45 days'
FROM temp_vendor;

-- Pending Review Draws (Awaiting admin approval)
INSERT INTO draws (
    vendor_id,
    title,
    description,
    category,
    bundle_value,
    status,
    items,
    images,
    submitted_at,
    created_at
)
SELECT 
    vendor_id,
    'Organic Farm Bundle',
    'Certified organic vegetables and fruits from our farm. Chemical-free and healthy!',
    'vegetables',
    110000,
    'pending_review',
    '["Organic Tomatoes 5kg", "Organic Carrots 3kg", "Organic Lettuce 2kg", "Organic Spinach 2kg", "Organic Cucumbers 2kg"]'::jsonb,
    '["https://images.unsplash.com/photo-1540420773420-3366772f4999?w=800"]'::jsonb,
    NOW() - INTERVAL '2 hours',
    NOW() - INTERVAL '2 hours'
FROM temp_vendor

UNION ALL

SELECT 
    vendor_id,
    'Seafood Extravaganza',
    'Premium seafood selection including prawns, crabs, and fresh fish.',
    'protein',
    250000,
    'pending_review',
    '["Fresh Prawns 3kg", "Crabs 2kg", "Tilapia 5kg", "Catfish 5kg", "Squid 2kg"]'::jsonb,
    '["https://images.unsplash.com/photo-1615937691194-97dbd3f3dc29?w=800"]'::jsonb,
    NOW() - INTERVAL '5 hours',
    NOW() - INTERVAL '5 hours'
FROM temp_vendor;

-- ============================================
-- STEP 3: Cleanup Temporary Table
-- ============================================
DROP TABLE IF EXISTS temp_vendor;

-- ============================================
-- VERIFICATION QUERY
-- ============================================
-- Run this to see the inserted draws
SELECT 
    title,
    category,
    bundle_value,
    ticket_price,
    total_tickets,
    sold_tickets,
    status,
    is_featured,
    created_at
FROM draws
ORDER BY created_at DESC
LIMIT 20;

-- ============================================
-- SUCCESS MESSAGE
-- ============================================
DO $$
BEGIN
    RAISE NOTICE '✅ Sample draws have been successfully inserted!';
    RAISE NOTICE '📊 Check the draws table to see your new data.';
    RAISE NOTICE '🎯 You now have:';
    RAISE NOTICE '   - 7 Active draws (ready for purchase)';
    RAISE NOTICE '   - 2 Completed draws (for history)';
    RAISE NOTICE '   - 2 Pending review draws (awaiting approval)';
END $$;
