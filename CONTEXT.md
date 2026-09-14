# Personal agent core

User-level skills and guidance that an agent should follow in any working directory, not only this repository.

## Language

**Skill catalog**:
A generated always-on list of every personal skill name and description. This repository does not emit one.
_Avoid_: routing table, thin pointer

**Client**:
An agent host with its own guidance home and skills home: Claude Code, Cursor, or Codex. Each is one
entry in `manifest.json`.

**Skills home**:
The user-level directory a client scans for installed personal skills, one per client:
`~/.claude/skills` for Claude Code and Cursor, `~/.agents/skills` for Codex. One canonical skill
tree, one link per home.
_Avoid_: skills repo, skills folder

**Shadow tree**:
A directory a client also scans, where a stale copy of a core skill would be listed beside or
instead of the installed link. Install snapshots and removes core-named entries there. Cursor:
`~/.cursor/skills`. Codex: none.
_Avoid_: fallback, skills fallback

**Guidance adapter**:
The generated per-client rendering of the canonical guidance under `generated/<client>/`. An
adapter adds the client's wrapper, such as Cursor's rule frontmatter, and never rewrites the body.
_Avoid_: rule file, instructions file

**Invocation policy**:
Whether a host may fire a skill without the user naming it. Claude reads `disable-model-invocation`
in the skill's frontmatter; Codex ignores that and reads `policy.allow_implicit_invocation` in
`agents/openai.yaml`. A skill is user-invoked everywhere only while both agree, so install refuses
one that disagrees with itself.

**Host skill list**:
The skill names and descriptions the agent host injects from its skills home. This is the index the model uses.

**Target repo**:
A working directory that is not this repository, where an agent session still needs personal skills.

**Overlay**:
A target repo that commits its own skills under `.claude/skills`, which a Cloud Agent gets without a
personal install. Those skills share the host skill list with the core, so install checks them for
collisions and never writes into the checkout. Named with `--overlay` or `AGENT_CORE_OVERLAY`;
otherwise the sibling `../web` checkout, and only while it carries skills.
_Avoid_: web repo

**Model-invoked skill**:
A skill the agent may fire on its own when the request matches its frontmatter description.

**User-invoked skill**:
A skill that runs only when the user names it. Other skills cannot fire it.

**Babysit**:
Keep an MR moving after it is opened: follow its pipeline, review threads, and mergeability until
it is ready to merge, blocked on a person, or merged. Fixes for branch-caused failures and
addressed review threads are part of babysitting, as is the opening self-review: one
`code-reviewer` agent dispatch at watch start. The merge itself is not; it belongs to the
`merge-mr` skill.
_Avoid_: watch (that is the pipeline-only poll a host plugin offers), monitor

**Ready to merge**:
The state where babysitting hands an MR to `merge-mr`: the head pipeline succeeded on the current
commit, nothing is unresolved, no conflicts, not a draft, GitLab reports it mergeable, approvals are
satisfied, and any trusted review bot has finished.
_Avoid_: green (that is the pipeline alone), done

**Review item**:
Something on an MR the babysitter must look at: an unresolved thread from someone else, a thread the
user started asking for a change, a new top-level note from someone else, a reviewer requesting
changes, or a revoked approval. Approvals granted and system notes are not items.
_Avoid_: comment, feedback

### Explainer

**Explainer**:
A single-file HTML page in the page template that explains one ticket's work: a Diagnosis, a
Resolution, or both, in that order.
_Avoid_: summary, report, write-up, work summary

**Diagnosis**:
The Explainer block that shows what the user sees, why it happens, and where each piece comes from.
_Avoid_: analysis, investigation

**Resolution**:
The Explainer block that shows what changes. Always follows Diagnosis when both are present.
_Avoid_: fix (that is one section inside a settled Resolution), solution

**Tense**:
Whether a Resolution is *settled* (the change shipped; it carries Verification and Deploy sections) or
*proposed* (the change is a candidate; it carries Alternatives and a Recommendation).
_Avoid_: mode, status, kind

**Mock-up**:
An HTML/CSS reproduction of real application UI inside an Explainer, built from the page template's
component library.
_Avoid_: screenshot (that is a captured image, not a reproduction), wireframe

**Page template**:
The one file holding an Explainer's style and section skeleton. Every Explainer is a filled copy;
page-specific style lives in one marked block, never in the shared tokens.
_Avoid_: theme, stylesheet, boilerplate
