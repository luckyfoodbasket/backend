-- ============================================
-- QUICK DRAW INSERT - Single Command Version
-- ============================================
-- This is a simplified version that you can run quickly
-- Just replace YOUR_VENDOR_ID with an actual vendor UUID

-- Option 1: Insert with a specific vendor_id
-- Replace 'YOUR_VENDOR_ID' with an actual UUID from your profiles table

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
    reviewed_at
) VALUES
-- Active Draw 1
(
    (SELECT id FROM profiles WHERE role = 'vendor' LIMIT 1), -- Auto-selects first vendor
    'Premium Family Food Bundle',
    'A complete family food package with rice, beans, oil, and fresh vegetables.',
    'mixed',
    150000,
    1000,
    200,
    45,
    'slot_complete',
    'active',
    true,
    '["Rice 50kg", "Beans 25kg", "Vegetable Oil 5L", "Tomatoes 10kg", "Onions 5kg"]'::jsonb,
    '["https://images.unsplash.com/photo-1542838132-92c53300491e?w=800"]'::jsonb,
    'Store in a cool, dry place.',
    'Delivery within 48 hours.',
    NOW() - INTERVAL '5 days',
    NOW() - INTERVAL '4 days'
),
-- Active Draw 2
(
    (SELECT id FROM profiles WHERE role = 'vendor' LIMIT 1),
    'Fresh Vegetable Basket',
    'Farm-fresh vegetables harvested daily.',
    'vegetables',
    75000,
    500,
    180,
    89,
    'slot_complete',
    'active',
    true,
    '["Tomatoes 5kg", "Carrots 3kg", "Cabbage 2 heads", "Spinach 2kg"]'::jsonb,
    '["https://images.unsplash.com/photo-1540420773420-3366772f4999?w=800"]'::jsonb,
    'Refrigerate immediately.',
    'Same-day delivery available.',
    NOW() - INTERVAL '3 days',
    NOW() - INTERVAL '2 days'
),
-- Active Draw 3
(
    (SELECT id FROM profiles WHERE role = 'vendor' LIMIT 1),
    'Protein Power Pack',
    'High-quality protein bundle with chicken, fish, and eggs.',
    'protein',
    200000,
    1500,
    150,
    67,
    'slot_complete',
    'active',
    false,
    '["Frozen Chicken 10kg", "Fresh Fish 5kg", "Eggs (2 crates)", "Beef 3kg"]'::jsonb,
    '["https://images.unsplash.com/photo-1607623814075-e51df1bdc82f?w=800"]'::jsonb,
    'Keep frozen at -18°C.',
    'Delivered in insulated bags.',
    NOW() - INTERVAL '6 days',
    NOW() - INTERVAL '5 days'
),
-- Active Draw 4
(
    (SELECT id FROM profiles WHERE role = 'vendor' LIMIT 1),
    'Tropical Fruit Basket',
    'Exotic and local fruits bursting with flavor.',
    'fruits',
    85000,
    550,
    170,
    78,
    'slot_complete',
    'active',
    true,
    '["Pineapples 3pcs", "Watermelon 1pc", "Oranges 2kg", "Bananas 2 bunches", "Apples 1kg"]'::jsonb,
    '["https://images.unsplash.com/photo-1610832958506-aa56368176cf?w=800"]'::jsonb,
    'Store in a cool place.',
    'Hand-picked fruits.',
    NOW() - INTERVAL '1 day',
    NOW() - INTERVAL '12 hours'
),
-- Active Draw 5
(
    (SELECT id FROM profiles WHERE role = 'vendor' LIMIT 1),
    'Mega Family Bundle',
    'Everything you need for a month!',
    'mixed',
    350000,
    2000,
    200,
    156,
    'slot_complete',
    'active',
    true,
    '["Rice 100kg", "Beans 50kg", "Vegetable Oil 10L", "Frozen Chicken 15kg", "Fresh Fish 10kg"]'::jsonb,
    '["https://images.unsplash.com/photo-1542838132-92c53300491e?w=800"]'::jsonb,
    'Requires adequate storage space.',
    'Refrigerated truck delivery.',
    NOW() - INTERVAL '7 days',
    NOW() - INTERVAL '6 days'
);

-- Verify the insert
SELECT 
    title,
    category,
    bundle_value,
    ticket_price,
    status,
    is_featured
FROM draws
ORDER BY created_at DESC
LIMIT 10;
