-- The IFRS 2025 taxonomy names the short-term lease expense element in full.
UPDATE "accounts"
SET "taxonomy_concept" = 'ifrs-full:ExpenseRelatingToShorttermLeasesForWhichRecognitionExemptionHasBeenUsed'
WHERE "taxonomy_concept" = 'ifrs-full:ExpenseRelatingToShorttermLeases';
