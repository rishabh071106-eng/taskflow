# Brodoit's book covers

Every book in the app wears a cover drawn here, in code: no publisher cover art (it is the publishers' copyright) and no
cover site. Each cover is a palette, an abstract motif chosen for the book's idea (`BOOK_MOTIF` in `make.py`: blocks
that compound for Atomic Habits, rings for Deep Work, a sunrise for The Miracle Morning …), the title in DM Serif Display
and the author in Plus Jakarta Sans. Both fonts are under the SIL Open Font License 1.1 (`fonts/OFL-*.txt`), which allows
drawing them into pictures like these; they are used only here, to make the images.

To redraw them (after adding a book, or changing a motif):

```bash
node scripts/covers/books.js > /tmp/books.json                 # the books, from BOOK_SUMMARIES in server.js
pip install fonttools pillow                                   # once
python scripts/covers/make.py /tmp/books.json /tmp/cover-svg   # SVGs (add ids at the end to redraw only those)
node scripts/covers/render.js /tmp/cover-svg /tmp/cover-png    # 600×800 PNGs (@resvg/resvg-js, already a dependency)
python scripts/covers/webp.py /tmp/cover-png app/covers        # app/covers/<id>.webp, ~16 KB each
```

Then bump `?v=` in `bookCover()` (server.js) so phones fetch the new pictures. A book without a file here shows its
colour, title and author instead (the `.bk-sum-cover` fallback).
