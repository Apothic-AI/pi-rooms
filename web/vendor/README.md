# Vendored: SolidJS 1.9.18

Unmodified upstream code, MIT licensed. Not a dependency, deliberately:

- The client is plain ESM loaded directly by the browser, so it needs no build
  pipeline to maintain and no `node_modules` at runtime.
- `solid-js` has no runtime dependencies of its own, so three files is the whole
  framework.

| File | Upstream |
|---|---|
| `solid.js` | `solid-js/dist/solid.js` |
| `solid-web.js` | `solid-js/web/dist/web.js` |
| `h.js` | `solid-js/h/dist/h.js` |

## The only change: bare specifiers rewritten to relative ones

A browser has no import map here and no bundler to resolve `solid-js/web`, so
each upstream file's bare specifier was rewritten to a relative path:

```
'solid-js'       ->  './solid.js'
'solid-js/web'   ->  './solid-web.js'
```

That is the entire diff. Verified with `grep -c "new Function"`: the `html`
tagged-template entry (`solid-js/html`) is **not** vendored, because it compiles
each template with `new Function` and the server sends `script-src 'self'` with no
`'unsafe-eval'`. Using it rendered a blank page. `h.js` builds the same DOM
through `document.createElement` and needs no eval, so the CSP stays strict and a
test asserts no bundle file contains `new Function`.

Regenerate with:

```sh
npm pack solid-js@1.9.18 --pack-destination /tmp
tar -xzf /tmp/solid-js-1.9.18.tgz -C /tmp
sed -i "s#from 'solid-js/web'#from './solid-web.js'#g; s#from 'solid-js'#from './solid.js'#g" \
  /tmp/package/dist/solid.js /tmp/package/web/dist/web.js /tmp/package/h/dist/h.js
```

## License

MIT License — Copyright (c) 2016-2025 Ryan Carniato

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
