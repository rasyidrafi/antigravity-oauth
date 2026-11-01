export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@zenmux/rosetta-ai") {
    throw new Error("The package root must not import Rosetta.");
  }
  return nextResolve(specifier, context);
}
