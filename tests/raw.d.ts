// Files imported as text (Vite's ?raw), such as wrangler.jsonc in the configuration test.
declare module '*?raw' {
  const text: string;
  export default text;
}
