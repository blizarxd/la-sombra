-- 💰 Why a capital-book position ended: waited for the oracle, followed the
-- arm's exit, or was sold once the outcome stopped being in doubt.
ALTER TABLE `capital_book` ADD `exit_reason` text;
