# Manual container layout controls

The feature is installed on the primary daemon at verified runtime `cfecb224a2786eaa46837a03a3009f68e26e6d8c`. Clean source, browser, static-export and production Helper checks passed, followed by actual Web UI acceptance at desktop and compact widths. It remains on the feature branch for draft PR review; plugin main is unchanged. See [verification and limits](verification/2026-11-01-container-layout.md).

Select a normal HTML container and open **布局** in its existing component toolbar. The menu offers three independent presentation choices:

- Keep its title visible and make its contents collapsible. An existing direct heading remains the same node. A container without a heading gets a text title.
- Put the complete component inside a titled collapsible group.
- Set a maximum content height from 80 to 2,000 CSS pixels. Taller content scrolls inside the component. Clear the height to remove the limit while retaining the selected folding mode.

**预览** builds an inert visual copy. The bottom handle adjusts the draft height; numeric input remains available. **完成布局** proposes the exact configuration to the host's Save/Cancel card. No source DOM changes until Save. **恢复原样** stages removal of the managed folding and height settings, and also requires preview and Save.

The new `layout` semantic patch carries the original canvas base, component identity and a bounded configuration. The live renderer and authored-source replay use the same transformation. The server accepts no caller-authored HTML or unrestricted CSS for this operation. Unknown save results keep the original request for retry; changed source or canvas conditions are refused.

Saving moves the existing content and heading nodes. Restoration removes only managed shells and reverts only the inline properties still owned by that layout; unrelated later author changes remain. Grid/flex placement uses a bounded property snapshot. Arbitrary child-combinator selectors and responsive rules cannot be reconstructed from a computed snapshot, so the preview remains necessary. Special content models, including native details, tables, SVG and editable controls, are outside this initial operation. A subtree containing a managed layout must first restore its layout before structural copying. Moving a managed summary, scroll body, original heading or only the inner source out of a managed group is refused. Insertion into fixed structural slots is also refused. Complete groups and contents containers remain movable, and ordinary content can enter or leave the contents body. Select a complete outer container or restore the layout first when necessary. These combinations refuse before mutation rather than leaving broken restoration metadata.

Folding structure and scroll limits belong to the authored Board and its static export. Current open/closed viewing choices live in a separate bounded state namespace, keyed by document version and stable layout identity. Author calls to `board.saveState()` preserve the current viewing namespace, including calls that write a stale whole-state snapshot. Viewing records are bounded to 512 keys; existing keys continue updating at that limit. A static publication starts without the author's private view state and remembers each visitor's choices within that release and hosting path.

Live Save and Restore retain the existing component, input values and event listeners. A complete page reload reconstructs the authored page and restores saved layout and viewing state; it does not preserve an arbitrary JavaScript heap or automatically persist an author's unsaved input.
