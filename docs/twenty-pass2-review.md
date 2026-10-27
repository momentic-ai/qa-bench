# Twenty high-effort pass 2 review

Working repository: `momentic-ai/qa-bench`. Migration checkpoint: 2026-10-27.

All 44 acceptance recommendations have human decisions: 43 accepted and one rejected. The acceptance queue is complete. All five disagreements are also decided: four accepted and one rejected. The 31 agreed rejection recommendations and one held attribution case remain available for later review; those recommendations are not human decisions.

The four areas now contain 224 accepted and 84 rejected references. The previous 177 accepted and 83 rejected references were already present; this change adds 47 approvals and one negative reference. P2-40 is severity 1 by explicit user decision. P2-7 was rejected without a stated reason and received no negative reference because it overlaps an existing confirmed LinkedIn defect; its decision remains in the local ledger.

## Frozen discovery results

Twelve high-effort runs produced 236 findings. Benchmark precision is 72.1% (93/129 known matched references), pooled recall 33.9% (60/177), and findings matched to any reference 57.6% (136/236), including rejected references. These are pre-update metrics, not precision over all findings. New labels do not retroactively alter them.

[Verified discovery archive](https://github.com/momentic-ai/qa-bench/tree/2ae53a00b3e1c41fa787d8a015a9c28c5abdc594/data) · [Archive registry](../eval-registry/refs/mo-evals/20261026-twenty-high-effort-pass2.json)

The archive retains its original commit and data tree. Its source commit and historical monorepo links record provenance, not the current working repository. Labeling evidence remains local under ignored `reports/labeling/twenty/`; it is excluded from the branch and archive. The local migration manifest records copied evidence and original locations. Existing qa-bench cleanup of source reports and internal judge session metadata is preserved; complete provenance remains in the local copies.

## Acceptance queue

| Case  | Finding                                                                                                                                                                | Human decision         | Severity |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | -------: |
| P2-26 | [Sorting Skills list by Type crashes AI settings with "Sorry, something went wrong"](../fixtures/oss/twenty/e2e/areas/settings-data-model/ground-truth.json)           | accepted               |        5 |
| P2-27 | [Sorting Companies Indexes by Unique crashes the settings page](../fixtures/oss/twenty/e2e/areas/settings-data-model/ground-truth.json)                                | accepted-related       |        5 |
| P2-3  | [Company side-panel activity context changes the main page count and new-record relation](../fixtures/oss/twenty/e2e/areas/record-pages-activities/ground-truth.json)  | accepted               |        3 |
| P2-7  | Person LinkedIn edit entered with Enter is displayed locally but not saved                                                                                             | rejected               |      n/a |
| P2-8  | [Valid workspace-logo replacement returns an error after saving the new image](../fixtures/oss/twenty/e2e/areas/settings-data-model/ground-truth.json)                 | accepted-related       |        3 |
| P2-11 | [Profile upload offers a disabled Abort during a long oversized-image request](../fixtures/oss/twenty/e2e/areas/settings-data-model/ground-truth.json)                 | accepted               |        3 |
| P2-13 | [Saved Skill Instructions autosave resets the editor, closing fullscreen and formatting menus](../fixtures/oss/twenty/e2e/areas/settings-data-model/ground-truth.json) | accepted               |        3 |
| P2-16 | [Double-clicking Save creates two API keys for one completed creation form](../fixtures/oss/twenty/e2e/areas/settings-data-model/ground-truth.json)                    | accepted               |        3 |
| P2-18 | [Skills Name sorting does not alphabetize the displayed skill names](../fixtures/oss/twenty/e2e/areas/settings-data-model/ground-truth.json)                           | accepted               |        3 |
| P2-24 | [Editing a stale Body-field popover overwrites the main note's recently saved paragraph](../fixtures/oss/twenty/e2e/areas/record-pages-activities/ground-truth.json)   | accepted related entry |        3 |
| P2-28 | [Group by None saves successfully but leaves Opportunities and Tasks grouped until reload](../fixtures/oss/twenty/e2e/areas/records-views/ground-truth.json)           | accepted related entry |        3 |
| P2-29 | [A resumed terminal Delay completes the workflow while another branch is unfinished](../fixtures/oss/twenty/e2e/areas/workflows/ground-truth.json)                     | accepted               |        3 |
| P2-30 | [Changing a saved Name filter to a relative date rule fails because its old field is retained](../fixtures/oss/twenty/e2e/areas/records-views/ground-truth.json)       | accepted related entry |        3 |
| P2-32 | [Delete Record and Update Record show an ineffective Remove variable X](../fixtures/oss/twenty/e2e/areas/workflows/ground-truth.json)                                  | accepted               |        3 |
| P2-33 | [Skipping a nested Iterator stalls the outer loop and leaves downstream actions unstarted](../fixtures/oss/twenty/e2e/areas/workflows/ground-truth.json)               | accepted               |        3 |
| P2-34 | [Inserting If/Else on an existing edge disconnects the downstream continuation](../fixtures/oss/twenty/e2e/areas/workflows/ground-truth.json)                          | accepted               |        3 |
| P2-35 | [Rejected fractional schedule activation leaves a persisted Active version without a registered trigger](../fixtures/oss/twenty/e2e/areas/workflows/ground-truth.json) | accepted               |        3 |
| P2-36 | [Duplicate from a read-only active Delay inspector changes a hidden draft and reports an error](../fixtures/oss/twenty/e2e/areas/workflows/ground-truth.json)          | accepted related entry |        3 |
| P2-37 | [Delay variable selection or removal stays local and is lost after ordinary panel navigation](../fixtures/oss/twenty/e2e/areas/workflows/ground-truth.json)            | accepted               |        3 |
| P2-38 | [A final skipped iteration disables Output for earlier successful iterations](../fixtures/oss/twenty/e2e/areas/workflows/ground-truth.json)                            | accepted               |        3 |
| P2-39 | [Restoring a workflow resurrects previously discarded drafts and makes one current](../fixtures/oss/twenty/e2e/areas/workflows/ground-truth.json)                      | accepted               |        3 |
| P2-40 | [Closing or switching the Code panel before its debounce fires permanently drops the visible array edit](../fixtures/oss/twenty/e2e/areas/workflows/ground-truth.json) | accepted related entry |        1 |
| P2-62 | [Reloading an index URL without viewId overwrites the remembered saved view](../fixtures/oss/twenty/e2e/areas/records-views/ground-truth.json)                         | accepted               |        3 |
| P2-63 | [Reselecting a saved sort from the Sort menu creates a duplicate and fails Update view](../fixtures/oss/twenty/e2e/areas/records-views/ground-truth.json)              | accepted related entry |        3 |
| P2-66 | Role object-rule wizard discards pending global restrictions after member assignment                                                                                   | accepted               |        3 |
| P2-70 | Typed Code number-array inputs save ordinary numeric members as strings                                                                                                | accepted               |        3 |
| P2-80 | Skipping a malformed placeholder-created Iterator suppresses the selected sibling and falsely completes the run                                                        | accepted related entry |        3 |
| P2-1  | Fullscreen code parameter saves while the side-panel input stays stale                                                                                                 | accepted related entry |        1 |
| P2-6  | Valid workspace image leaves a blank preview after an invalid upload                                                                                                   | accepted related entry |        1 |
| P2-9  | Number format preview omits the requested trailing decimal zeros                                                                                                       | accepted related entry |        1 |
| P2-12 | Resizing an open TXT or PDF attachment preview across the mobile breakpoint blanks its content                                                                         | accepted               |        1 |
| P2-14 | Pinned Export View action disappears from header immediately after saving Layout customization                                                                         | accepted related entry |        1 |
| P2-25 | Ctrl+K in selected note text opens both link editor and full command menu                                                                                              | accepted               |        1 |
| P2-31 | A newly created nonmatching Company leaves a stale row in a populated filtered group                                                                                   | accepted               |        1 |
| P2-41 | Renaming a favorited record leaves its sidebar label and tooltip stale across reloads                                                                                  | accepted               |        1 |
| P2-43 | Opportunities Kanban group order resets from Alphabetical to Manual on reload                                                                                          | accepted related entry |        1 |
| P2-44 | A narrow Company Timeline hides the related Task or Note identity beside a long timestamp                                                                              | accepted related entry |        1 |
| P2-45 | Percentage edit inputs expose floating-point noise when reopened                                                                                                       | accepted               |        1 |
| P2-46 | Adding Else-if routes overlaps live branch labels and nodes despite correct saved positions                                                                            | accepted               |        1 |
| P2-47 | Populated multi-destination record fields omit the hover pencil, leaving only the padding edit target                                                                  | accepted               |        1 |
| P2-48 | Schedule validation messages display literal {newMinute}, {newHour} and {newDay} placeholders                                                                          | accepted               |        1 |
| P2-51 | Days schedule preview contradicts Days between triggers at calendar boundaries                                                                                         | accepted               |        1 |
| P2-52 | Mobile Relations table collapses names under App badges                                                                                                                | accepted               |        1 |
| P2-69 | Returning to cached Workflow Runs omits runs created in another tab                                                                                                    | accepted               |        1 |

## Disagreement decisions

P2-5: rejected as intended approximate Data model counts. P2-42: accepted at severity 1 for missing Domain validation explanation, with exclusion guidance on the older outline-only negative. P2-50: accepted at severity 1 for ambiguous version labels. P2-53: accepted at severity 1 for inconsistent Emails preview limits. P2-76: accepted at severity 1 for missing named-type input fields. All five disagreements are decided: four accepted and one rejected. The held attribution case and 31 agreed rejection recommendations remain unjudged.

Total human decisions: 49 of 81 eligible cases, comprising 47 accepted and two rejected proposals. One rejection is retained only in the local decision ledger because it overlaps a confirmed accepted defect. The 31 agreed rejection recommendations and one held attribution case remain unjudged.
