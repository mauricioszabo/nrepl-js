import { parse } from "@babel/parser";
import defaultM from "@babel/traverse";
import fs from 'fs/promises'

import repl from "node:repl";

const traverse = defaultM.default

function readFile(file) {
  return fs.readFile(file, 'utf-8').catch(() => {})
}

export async function instrumentSource(cdp, {url, scriptId}) {
  const fileName = url.replace(/file:\/\//, '')
  // console.log("FILE", fileName)
  // if (! await checkExists(fileName) ) return
  //
  // console.log("HAVE_ACCESS", await await checkExists(fileName))
  //
  const contents = await readFile(fileName)
  if(!contents) return
  console.log("Instrumenting?")
  const parsed = parse(contents)

  traverse(parsed, {
    FunctionDeclaration(path) {
      addDebugPoint(cdp, url, fileName, path)
    },

    ObjectMethod(path) {
      addDebugPoint(cdp, url, fileName, path)
    },

    ClassMethod(path) {
      addDebugPoint(cdp, url, fileName, path)
    },

    ClassPrivateMethod(path) {
      addDebugPoint(cdp, url, fileName, path)
    },
  });
}

function addDebugPoint(cdp, url, file, path) {
  const loc = path?.node?.body?.loc
  if(!loc) return

  const defaultWatch = '{ watchPoints: {}, watchPointsIds: {}, sources: {}}'
  const addWatchCmd = `((globalThis.__lazuli ||= ${defaultWatch}).watchPoints['${file}'] ||= {})[${loc.start.line-1}] = (code) => eval(code)`
  // const addWatchCmd = `((global.__lazuli ||= ${defaultWatch}).watchPoints['${file}'] ||= {})[${loc.start.line-1}] = false`
  console.log("Adding debugger", file, loc.start.line)
  const res = cdp.send('Debugger.setBreakpointByUrl', {
    url,
    lineNumber: loc.start.line,
    // columnNumber: loc.start.c,
    condition: `(${addWatchCmd}) && false`
  });

  res.then( r => console.log("Added debugger", file, loc.start.line, r))
    .catch( r => console.log("Failed debugger", file, loc.start.line, r))
}
