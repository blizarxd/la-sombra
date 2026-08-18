-- ₿ Reset the cripto book. Its first run used two rules the +35.5% finding was
-- never measured under: no 55-59c band filter (entries landed at 36c, 40c, 63c)
-- and a 6h time stop the capital book does not have. Those 14 trades measured a
-- different strategy, so keeping them would contaminate the comparison exactly
-- the way mixing two designs in one ledger did before.
DELETE FROM `cripto_book`;
