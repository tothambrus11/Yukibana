// Minimal edge function, used by `npm run smoke` to prove the edge runtime is up
// and that cloud/db/supabase/functions is correctly bind-mounted into it.
Deno.serve(
  () =>
    new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' },
    }),
);
