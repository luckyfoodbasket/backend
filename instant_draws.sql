-- ============================================
-- INSTANT DRAW CREATOR
-- ============================================
-- Copy this entire block and run in Supabase SQL Editor
-- Creates 3 active draws instantly!

INSERT INTO draws (
    vendor_id, title, description, category, bundle_value, 
    ticket_price, total_tickets, sold_tickets, draw_type, 
    status, is_featured, items, images, submitted_at, reviewed_at
) VALUES
(
    (SELECT id FROM profiles LIMIT 1),
    'Family Food Bundle',
    'Complete family package with rice, beans, and vegetables',
    'mixed',
    150000, 1000, 200, 45, 'slot_complete', 'active', true,
    '["Rice 50kg", "Beans 25kg", "Oil 5L", "Tomatoes 10kg"]'::jsonb,
    '["https://images.unsplash.com/photo-1542838132-92c53300491e?w=800"]'::jsonb,
    NOW(), NOW()
),
(
    (SELECT id FROM profiles LIMIT 1),
    'Fresh Vegetables',
    'Farm-fresh vegetables delivered daily',
    'vegetables',
    75000, 500, 180, 89, 'slot_complete', 'active', true,
    '["Tomatoes 5kg", "Carrots 3kg", "Spinach 2kg"]'::jsonb,
    '["https://images.unsplash.com/photo-1540420773420-3366772f4999?w=800"]'::jsonb,
    NOW(), NOW()
),
(
    (SELECT id FROM profiles LIMIT 1),
    'Protein Pack',
    'Chicken, fish, and eggs bundle',
    'protein',
    200000, 1500, 150, 67, 'slot_complete', 'active', false,
    '["Chicken 10kg", "Fish 5kg", "Eggs 2 crates"]'::jsonb,
    '["https://images.unsplash.com/photo-1607623814075-e51df1bdc82f?w=800"]'::jsonb,
    NOW(), NOW()
);
