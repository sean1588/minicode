import { Processor } from "./processor.js";

async function main(): Promise<void> {
  const processor = new Processor();
  const result = await processor.run({
    id: "1",
    input: "hello",
  });
  console.log(result.output);
}

main().catch(console.error);
