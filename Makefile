# Makefile

default: worksheets

.PHONY: worksheets
worksheets:
	@python3 worksheet.py apps/

.PHONY: clean

clean:
	@rm worksheets/*.pdf
