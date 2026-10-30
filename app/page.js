import Link from "next/link"

export default function Home() {
  return (
    <main>
      <h1>Home</h1>
      <Link href="/target" id="to-target">
        Go to /target
      </Link>
    </main>
  )
}
