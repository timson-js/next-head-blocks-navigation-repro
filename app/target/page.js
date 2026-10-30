import { connection } from "next/server"

export default async function Target() {
  await connection()
  await new Promise((resolve) => setTimeout(resolve, 1200))
  return <h1 id="target-content">Target</h1>
}
