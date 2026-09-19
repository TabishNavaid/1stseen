export default function Loading() {
  return <main className="flex-1 bg-canvas p-6" aria-busy="true"><div className="mx-auto max-w-6xl" role="status"><div className="skeleton h-8 w-48" aria-hidden="true" /><div className="mt-6 grid gap-5 lg:grid-cols-[1.4fr_.8fr]" aria-hidden="true"><div className="skeleton h-[620px] border border-line" /><div className="skeleton h-[620px] border border-line" /></div><p className="sr-only">Loading recruiting intelligence</p></div></main>;
}
