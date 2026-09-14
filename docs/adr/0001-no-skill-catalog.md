# Host skill list, not a generated skill catalog

Always-on Cursor and Claude guidance used to copy every personal skill name and description. That duplicated the host skill list. It also spent tokens on user-invoked skills the host already hides, and it still failed to make those skills fire. We generate behaviour rules only. Model-invoked skills reach a target repo because install puts them in the personal skills home and the host injects them. User-invoked skills stay off that list. `/ask-matt` is the human index.

Considered and rejected: a short always-on reminder naming the personal skills home. It restates what the host already supplies.
