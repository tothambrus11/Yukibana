// Minimal edge function, used by `node cloud/dev/scripts/smoke.mjs` to prove the edge runtime is up
// and that cloud/db/supabase/functions is correctly bind-mounted into it.
Deno.serve(
  () =>
    new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' },
    }),
);
