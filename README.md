# scratch-worksheets

This repo contains a program for taking a Scratch exported app (an `sb3` file),
separating the blocks and randomising the order, then generating a PDF worksheet
using a markdown file with a title and some instructions.

## Process

1. Save your app to your computer:

   ![Scratch's File menu, with "Save to your computer" highlighted](readme_images/scratch-save-to-computer.png)
1. Move the app to the `apps` directory in this repo.
1. Run `make` or `python3 worksheet.py`
1. You should see a new PDF file in the `worksheets` directory.
