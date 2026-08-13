-- 📏 Depth ladder: how much size each book absorbed at entry.
-- Measurement only. Captured from the order book already fetched to simulate
-- the fill, so it costs no extra API calls and changes nothing about what the
-- bot copies or at what size.
ALTER TABLE `paper_trades` ADD `depth_ladder_json` text;
