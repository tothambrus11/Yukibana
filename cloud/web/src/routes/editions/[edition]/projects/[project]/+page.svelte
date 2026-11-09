<script lang="ts">
  import { page } from '$app/state';
  import Tabs from '#lib/Tabs.svelte';
  import { kb, when } from '#lib/format.ts';
  import { viewer } from '#lib/viewer.svelte.ts';
  import { local } from '#lib/wall-time.ts';
  import { ideUrl } from '#lib/ide.ts';
  import { hold, live, refresh } from '#lib/live.svelte.ts';
  import { actionIn, tabOf, type Tab } from '#lib/tabs.ts';
  import { handInsOf } from '#lib/hand-ins.ts';
  import HandInsTable from '#lib/hand-ins/HandInsTable.svelte';
  import type { ActionData, PageData } from './$types';
  let { data, form }: { data: PageData; form: ActionData } = $props();
  const p = $derived(data.project);
  // Without a starter there is nothing to start from, so nothing to submit:
  // the page leaves submissions out until one is released. Submissions that
  // exist anyway (sent through the API before any release) stay visible.
  const submissions = $derived(p.ready || data.submissions.length > 0);
  const tabs = $derived<Tab[]>(data.staff
    ? [
        { id: 'overview', label: 'Overview' },
        ...(submissions ? [{ id: 'submissions', label: 'Submissions', count: data.submissions.length }] : []),
        { id: 'releases', label: 'Releases', count: data.releases.length },
        ...(data.owner ? [{ id: 'tokens', label: 'Tokens' }] : []),
        ...(data.project.can_edit ? [{ id: 'settings', label: 'Settings' }] : []),
      ]
    : [
        { id: 'overview', label: 'Overview' },
        ...(submissions ? [{ id: 'submissions', label: 'My submissions', count: data.submissions.length }] : []),
      ]);
  const tab = $derived(tabOf(page.url, tabs));
  const times = $derived([
    ['available_after', 'Opens', p.available_after],
    ['deadline', 'Deadline', p.deadline],
    ['closes_at', 'Closes', p.closes_at],
  ] as const);
  const pastDeadline = $derived(p.deadline !== null && new Date(p.deadline).getTime() <= Date.now());
  const students = $derived(new Set(data.submissions.map((s) => s.authorId)).size);
  const late = $derived(data.submissions.filter((s) => s.late).length);
  // Staff see one line per student, including those who sent nothing.
  const lines = $derived(handInsOf(data.students, data.submissions));

  // The settings form follows the project live until somebody types in it.
  // From then on changes from others are held back, so the form is never
  // rewritten under the cursor, and the page says that it is out of date;
  // saving replaces their change, discarding loads it.
  let editing = $state(false);
  // Tabs are links within one page, so the page survives switching tabs but
  // the form does not: edits left behind on another tab are gone, and must
  // not go on holding the page back.
  $effect(() => {
    if (tab !== 'settings') editing = false;
  });
  $effect(() => (editing ? hold() : undefined));
  // Saving is a plain form post: the page stays on screen until the answer
  // arrives, and the save's own broadcast usually arrives first. It is news
  // about our change, not somebody else's, so while a save is on its way the
  // page does not say it is out of date. It used to, and every save flashed
  // the warning before "Saved.".
  let saving = $state(false);
  function discard(): void {
    editing = false;
    refresh();
  }
</script>

<div class="head">
  <nav class="crumbs" aria-label="Breadcrumb">
    <a href="/">Courses</a>
    <a href="/editions/{p.edition_id}">{p.course_code} {p.edition_label}</a>
    <span>{p.title}</span>
  </nav>
  <h1>{p.title}</h1>
  <p class="row">
    <span class="chip">{p.kind}</span>
    {#if data.staff && p.available_after === null}<span class="chip">draft</span>{/if}
    {#if pastDeadline}<span class="chip late">past the deadline</span>{/if}
  </p>
</div>

<Tabs {tabs} current={tab} />

{#if tab === 'overview'}
  {#if form?.submitted}
    <p class="ok">Submission received: {kb(form.submitted.byteSize)}, SHA-256 {form.submitted.sha256.slice(0, 16)}…</p>
  {/if}
  <section>
    <h2>Dates</h2>
    <div class="stats">
      <div><strong>{when(p.available_after, viewer.zone)}</strong><span>Opens</span></div>
      <div><strong>{when(p.deadline, viewer.zone)}</strong><span>Deadline</span></div>
      <div><strong>{p.closes_at === null ? 'Never' : when(p.closes_at, viewer.zone)}</strong><span>Closes</span></div>
    </div>
    {#if submissions}
      <p class="note">
        Submissions after the deadline are accepted until the project closes, and are marked late.
      </p>
    {/if}
  </section>

  {#if data.staff}
    <section>
      <h2>At a glance</h2>
      <div class="stats">
        {#if submissions}
          <div><strong>{data.submissions.length}</strong><span>Submissions</span></div>
          <div><strong>{students}</strong><span>Students who submitted</span></div>
          <div><strong>{late}</strong><span>Late submissions</span></div>
        {/if}
        <div><strong>{data.releases.length}</strong><span>Releases</span></div>
      </div>
    </section>
  {/if}

  <section>
    <h2>{data.staff ? 'Starter' : 'Work on it'}</h2>
    {#if p.ready}
      <p class="row">
        <a class="button" href={ideUrl(p.project_id)}>Open in Yukibana IDE</a>
        <a class="button quiet" href="/api/projects/{p.project_id}/starter">Download {p.slug}.tar.gz</a>
      </p>
      {#if !data.staff}<p class="note">The IDE opens the project, downloading it if needed. Without the IDE, download the starter and work in that folder.</p>{/if}
    {:else}
      <p class="empty">No exercise contents have been released yet.</p>
    {/if}
  </section>

  {#if !data.staff && p.ready}
    <section id="submit">
      <h2>Submit your solution</h2>
      {#if p.can_submit}
        {#if pastDeadline}<p class="error">The deadline has passed: a submission now is recorded as late.</p>{/if}
        <form method="POST" action={actionIn('overview', 'submit')} enctype="multipart/form-data" class="stack">
          <label>Your solution as .tar.gz
            <input type="file" name="archive" accept=".gz,.tgz,application/gzip" required />
          </label>
          <button>Submit</button>
        </form>
        <p class="note">
          You can submit as many times as you like. Every version is kept; the latest version is the one assessed.
          The IDE's submit button sends the right archive for you; to make one by hand, run <code>yukibana pack</code> in the project folder.
        </p>
      {:else}
        <p class="empty">This project is not accepting submissions from you now.</p>
      {/if}
    </section>
  {/if}
{:else if tab === 'submissions'}
  {#if data.staff}
    {#if form?.removed}<p class="ok" role="status">Submission removed.</p>{/if}
    <section>
      <h2>Submissions</h2>
      {#if lines.length === 0}
        <p class="empty">Nobody is enrolled as a student yet.</p>
      {:else}
        <HandInsTable {lines} releases={data.allReleases} slug={p.slug} removeAction={actionIn('submissions', 'removeSubmission')} />
      {/if}
    </section>
  {:else}
    <section>
      <h2>My submissions</h2>
      {#if data.submissions.length === 0}
        <p class="empty">None yet.</p>
      {:else}
        <div class="scroll">
          <table>
            <thead>
              <tr><th>Submitted</th><th>Size</th><th>SHA-256</th><th></th></tr>
            </thead>
            <tbody>
              {#each data.submissions as s (s.submissionId)}
                <tr>
                  <td>{when(s.submittedAt, viewer.zone)}{#if s.late} <span class="chip late">late</span>{/if}</td>
                  <td>{kb(s.byteSize)}</td>
                  <td><code>{s.sha256.slice(0, 12)}</code></td>
                  <td><a href="/api/submissions/{s.submissionId}">Download</a></td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </section>
  {/if}
{:else if tab === 'releases'}
  <section>
    <h2>Releases</h2>
    {#if data.releases.length === 0}
      <p class="empty">
        No releases yet. A release is two archives: the starter students get, and the whole project
        for staff.
      </p>
    {:else}
      <div class="scroll">
        <table>
          <thead>
            <tr><th>Uploaded</th><th>Label</th><th>Commit</th><th>By</th><th>Starter</th><th>Teacher archive</th></tr>
          </thead>
          <tbody>
            {#each data.releases as r, i (r.release_id)}
              <tr>
                <td>{when(r.uploaded_at, viewer.zone)}{#if i === 0} <span class="chip live">live</span>{/if}</td>
                <td>{r.label}</td>
                <td><code>{r.commit_sha?.slice(0, 12) ?? '—'}</code></td>
                <td>{r.uploader ?? ''}{#if r.via_token} <span class="chip">token</span>{/if}</td>
                <td><a href="/api/releases/{r.release_id}/starter">{kb(r.starter_size)}</a></td>
                <td><a href="/api/releases/{r.release_id}/teacher">{kb(r.teacher_size)}</a></td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>

  {#if p.can_edit}
    <section>
      <h2>Publish a release</h2>
      <p>
        From a checkout of the project, <code>yukibana publish --project {p.project_id}</code>
        builds both archives and publishes them, logged in as staff. CI publishes the same way,
        with a token an owner makes in the Tokens tab. There is no upload here: the release id
        has to travel inside the starter, and only the CLI puts it there.
      </p>
    </section>
  {/if}
{:else if tab === 'tokens'}
  {#if form?.token}
    <section>
      <h2>Your new token</h2>
      <p class="ok">Token "{form.token.label}" created. Copy it now; it is not shown again.</p>
      <pre>{form.token.secret}</pre>
    </section>
  {/if}
  <section>
    <h2>Publishing tokens</h2>
    <p>A token publishes releases to this project and nothing else. Put it in your repository's secrets:</p>
    <pre>YUKIBANA_TOKEN   (the secret)
YUKIBANA_PROJECT {p.project_id}
YUKIBANA_URL     {data.origin}</pre>
    {#if data.tokens.length > 0}
      <div class="scroll">
        <table>
          <thead><tr><th>Label</th><th>Created</th><th>Last used</th><th></th></tr></thead>
          <tbody>
            {#each data.tokens as t (t.token_id)}
              <tr>
                <td>{t.label}</td>
                <td>{when(t.created_at, viewer.zone)}</td>
                <td>{#if t.revoked_at}<span class="chip">revoked</span>{:else}{when(t.last_used_at, viewer.zone)}{/if}</td>
                <td>
                  {#if !t.revoked_at}
                    <form method="POST" action={actionIn('tokens', 'revokeToken')} class="inline">
                      <input type="hidden" name="token_id" value={t.token_id} />
                      <button>Revoke</button>
                    </form>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>
  <section>
    <h2>New token</h2>
    <form method="POST" action={actionIn('tokens', 'createToken')} class="stack">
      <label>Label <input name="label" placeholder="github actions" /></label>
      <button>Create token</button>
    </form>
  </section>
{:else if tab === 'settings'}
  {#if form?.ok}<p class="ok">Saved.</p>{/if}
  <section>
    <h2>Settings</h2>
    {#if editing && live.stale && !saving}
      <p class="error" role="alert">
        Somebody else changed this project while you were editing. Saving replaces their change.
        <button type="button" class="quiet" onclick={discard}>Discard my edits and show theirs</button>
      </p>
    {/if}
    {#key p}
      <form method="POST" action={actionIn('settings', 'update')} class="stack" oninput={() => (editing = true)} onsubmit={() => (saving = true)}>
        <label>Title <input name="title" value={p.title} required /></label>
        <!-- The zone the times below are written in, and the instants they
             were written from: the action reads the times in that zone, and
             keeps an instant whose time nobody changed (#lib/wall-time). -->
        <input type="hidden" name="zone" value={viewer.zone} />
        {#each times as [name, label, at] (name)}
          <input type="hidden" name="{name}_was" value={at === null ? '' : new Date(at).toISOString()} />
          <label>{label} <input type="datetime-local" {name} value={local(at, viewer.zone)} /></label>
        {/each}
        <p class="note">Times are in {viewer.zone}{viewer.zone === 'UTC' ? '' : ', this browser’s time zone'}.</p>
        <button>Save</button>
      </form>
    {/key}
    <p class="note">
      Without an opening date students cannot see the project at all. Between the deadline and the
      closing date, submissions are accepted and marked late; after closing, students no longer see
      the project. Without a closing date, late work is accepted indefinitely.
    </p>
  </section>
{/if}
