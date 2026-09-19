export async function GET() {
  return Response.json({ service: "1stseen-web", status: "ok", timestamp: new Date().toISOString() });
}
