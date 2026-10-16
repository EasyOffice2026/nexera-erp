-- The place of a statement line within its statement, oldest first.
ALTER TABLE "bank_statement_lines" ADD COLUMN "line_no" INTEGER NOT NULL;
