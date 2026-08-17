-- 📉 Sell-side snapshot: top bid levels at each mark, so exits can be priced
-- by walking the book for the real share count. The depth ladder already
-- proved a book can absorb the BUY; nothing checked the matching SELL.
ALTER TABLE `paper_trades` ADD `bid_levels_json` text;
