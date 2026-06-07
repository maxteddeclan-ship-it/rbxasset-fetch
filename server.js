"use strict"

try { require("dotenv").config() } catch {}
const express = require("express")
const { RBXModelParser, jsonReplacer } = require("./lib/RBXParser")
const { bufferToString } = require("./lib/ByteReader")

const app = express()
const PORT = process.env.PORT || 3000
const HOST = process.env.HOST || "127.0.0.1"
const ASSET_CACHE_TTL_MS = parseInt(process.env.ASSET_CACHE_TTL_MS || "300000", 10)
const assetCache = new Map()

function instanceToJSON(instance) {
	const json = {
		ClassName: instance.getProperty("ClassName"),
		Name: instance.getProperty("Name"),
	}
	const skipProps = new Set(["ClassName", "Name", "Parent", "Children"])
	for (const [key, prop] of Object.entries(instance.Properties)) {
		if (!skipProps.has(key)) {
			json[key] = serializeValue(prop.value, prop.type)
		}
	}
	if (instance.Children && instance.Children.length > 0) {
		json.Children = instance.Children.map(child => instanceToJSON(child))
	}
	return json
}

function serializeValue(value, type) {
	if (value === null || value === undefined) return null
	if (type === "Instance" && value && typeof value === "object" && value.ClassName) {
		return { __type: "Instance", ClassName: value.getProperty("ClassName"), Name: value.getProperty("Name") }
	}
	if (Array.isArray(value)) return value
	if (typeof value === "object" && value !== null && !(value instanceof Date)) {
		const result = {}
		for (const [k, v] of Object.entries(value)) {
			result[k] = serializeValue(v, type)
		}
		return result
	}
	if (typeof value === "bigint") return value.toString()
	return value
}

function getCookie(req) {
	if (process.env.ALLOW_HEADER_COOKIE === "true" && req.headers["x-roblox-cookie"]) {
		return String(req.headers["x-roblox-cookie"]).trim()
	}
	return (process.env.ROBLOX_COOKIE || "").trim()
}

async function fetchWithRetry(url, options, maxRetries = 3) {
	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		const res = await fetch(url, options)
		if (res.status === 429) {
			const retryAfter = parseInt(res.headers.get("retry-after") || "5", 10)
			const delay = Math.min(retryAfter * 1000, 30000)
			console.log(`  Rate limited (429), waiting ${delay}ms (attempt ${attempt + 1}/${maxRetries + 1})...`)
			await new Promise(r => setTimeout(r, delay))
			continue
		}
		return res
	}
	throw new Error("Rate limited too many times")
}

async function fetchAsset(assetId, cookie) {
	const cacheKey = `${assetId}:${cookie || "anonymous"}`
	const cached = assetCache.get(cacheKey)
	if (cached && Date.now() - cached.createdAt < ASSET_CACHE_TTL_MS) {
		console.log(`  Cache hit for asset ${assetId}`)
		return cached.value
	}
	const value = await fetchAssetUncached(assetId, cookie)
	assetCache.set(cacheKey, { createdAt: Date.now(), value })
	return value
}

async function fetchAssetUncached(assetId, cookie) {
	const hasCookie = !!cookie
	console.log(`  Cookie present: ${hasCookie}, length: ${cookie?.length || 0}`)
	const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"

	try {
		console.log(`  Trying RoProxy...`)
		const roproxyUrl = `https://assetdelivery.roproxy.com/v2/asset/?id=${assetId}`
		const res = await fetchWithRetry(roproxyUrl, { headers: { "User-Agent": ua, "Accept": "application/json" } })
		if (res.ok) {
			const json = await res.json()
			if (json.locations && json.locations.length > 0) {
				console.log(`  RoProxy succeeded`)
				return await downloadFromLocations(json)
			}
		}
		console.log(`  RoProxy failed (${res.status}), falling back to cookie...`)
	} catch (e) {
		console.log(`  RoProxy error: ${e.message}, falling back to cookie...`)
	}

	if (!cookie) throw new Error(`RoProxy failed and no cookie provided. Set ROBLOX_COOKIE in .env`)

	const cookieHeader = `.ROBLOSECURITY=${cookie}`
	let csrfToken = ""
	try {
		const csrfRes = await fetchWithRetry("https://auth.roblox.com/v2/logout", { method: "POST", headers: { "User-Agent": ua, "Cookie": cookieHeader } })
		csrfToken = csrfRes.headers.get("x-csrf-token") || ""
		if (csrfToken) console.log(`  Got CSRF token`)
	} catch {}

	const headers = { "User-Agent": ua, "Accept": "application/json", "Roblox-Browser-Asset-Request": "true" }
	if (cookieHeader) headers["Cookie"] = cookieHeader
	if (csrfToken) headers["X-CSRF-TOKEN"] = csrfToken

	const url = `https://assetdelivery.roblox.com/v2/asset/?id=${assetId}`
	console.log(`  Fetching: ${url}`)
	const res = await fetchWithRetry(url, { headers })

	if (!res.ok) {
		if (res.status === 403) {
			const newCsrf = res.headers.get("x-csrf-token")
			if (newCsrf) {
				console.log(`  Got new CSRF, retrying...`)
				headers["X-CSRF-TOKEN"] = newCsrf
				const retryRes = await fetchWithRetry(url, { headers })
				if (!retryRes.ok) {
					const body = await retryRes.text().catch(() => "")
					throw new Error(`Asset fetch failed: ${retryRes.status} - ${body.substring(0, 200)}`)
				}
				return await processAssetResponse(retryRes)
			}
		}
		const body = await res.text().catch(() => "")
		throw new Error(`Asset fetch failed: ${res.status} - ${body.substring(0, 200)}`)
	}

	return await processAssetResponse(res)
}

async function downloadFromLocations(json) {
	const cdnUrl = json.locations[0].location
	console.log(`  Downloading from CDN...`)
	const cdnRes = await fetch(cdnUrl, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } })
	if (!cdnRes.ok) throw new Error(`CDN download failed: ${cdnRes.status}`)
	return { buffer: Buffer.from(await cdnRes.arrayBuffer()), assetTypeId: json.assetTypeId }
}

async function processAssetResponse(res) {
	const json = await res.json()
	if (json.errors) throw new Error(`Roblox API error: ${JSON.stringify(json.errors)}`)
	if (!json.locations || json.locations.length === 0) throw new Error(`No download locations for asset`)
	const cdnUrl = json.locations[0].location
	console.log(`  Downloading from CDN...`)
	const cdnRes = await fetch(cdnUrl, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } })
	if (!cdnRes.ok) throw new Error(`CDN download failed: ${cdnRes.status}`)
	return { buffer: Buffer.from(await cdnRes.arrayBuffer()), assetTypeId: json.assetTypeId }
}

function parseList(str) {
	if (!str) return new Set()
	return new Set(str.split(",").map(s => s.trim()).filter(Boolean))
}

function countFiltered(instances, ignoreSet) {
	let count = 0
	for (const inst of instances) {
		if (ignoreSet.has(inst.ClassName)) {
			count += 1 + (inst.Children ? countFiltered(inst.Children, ignoreSet) : 0)
		} else if (inst.Children) {
			count += countFiltered(inst.Children, ignoreSet)
		}
	}
	return count
}

function filterInstances(instances, ignoreSet) {
	if (ignoreSet.size === 0) return instances
	return instances
		.filter(inst => !ignoreSet.has(inst.ClassName))
		.map(inst => {
			if (inst.Children && inst.Children.length > 0) {
				return { ...inst, Children: filterInstances(inst.Children, ignoreSet) }
			}
			return inst
		})
}

function stripProperties(instances, ignoreProps) {
	if (ignoreProps.size === 0) return instances
	return instances.map(inst => {
		const out = {}
		for (const [k, v] of Object.entries(inst)) {
			if (!ignoreProps.has(k)) {
				out[k] = k === "Children" && Array.isArray(v) ? stripProperties(v, ignoreProps) : v
			}
		}
		return out
	})
}

function countInstances(instances) {
	let count = instances.length
	for (const inst of instances) {
		if (inst.Children) count += countInstances(inst.Children)
	}
	return count
}

function flattenInstances(instances, result, path, ignoreSet) {
	for (const inst of instances) {
		const instClassName = inst.getProperty("ClassName")
		if (ignoreSet && ignoreSet.has(instClassName)) continue
		const currentPath = path ? `${path}/${inst.getProperty("Name") || "?"}` : (inst.getProperty("Name") || "?")
		const json = instanceToJSON(inst)
		json.path = currentPath
		result.push(json)
		if (inst.Children && inst.Children.length > 0) {
			flattenInstances(inst.Children, result, currentPath, ignoreSet)
		}
	}
}

// Routes

app.get("/", (req, res) => {
	res.setHeader("Content-Type", "text/html")
	res.send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>rbxasset-fetch API</title></head>
<body>
<h1>rbxasset-fetch</h1>
<p>Parses Roblox RBXM/RBXMX assets and returns JSON.</p>

<h2>Endpoints</h2>

<h3>GET /asset/:id</h3>
<p>Fetch and parse a Roblox asset. Returns nested JSON.</p>
<pre>GET /asset/6880366374</pre>

<h3>GET /asset/:id/tree</h3>
<p>Flat tree view. Returns all instances in a flat array with paths.</p>
<pre>GET /asset/6880366374/tree</pre>

<h3>GET /asset/:id/search?class=X</h3>
<p>Search instances by class name, property name, or property value.</p>
<pre>GET /asset/6880366374/search?class=Part
GET /asset/6880366374/search?prop=Anchored&amp;value=true
GET /asset/6880366374/search?class=Part&amp;prop=Material&amp;value=Plastic</pre>

<h3>GET /asset/:id/class/:className</h3>
<p>Get all instances of a specific class.</p>
<pre>GET /asset/6880366374/class/Part</pre>

<h3>GET /asset/:id/raw</h3>
<p>Return the raw asset buffer. XML if RBXMX, base64 otherwise.</p>
<pre>GET /asset/6880366374/raw</pre>

<h3>GET /health</h3>
<p>Health check. Returns server status and cache info.</p>
<pre>GET /health</pre>

<h2>Query Parameters</h2>

<h3>ignoreClasses</h3>
<p>Comma-separated list of class names to exclude from results.</p>
<pre>GET /asset/6880366374?ignoreClasses=Folder,Script
GET /asset/6880366374/tree?ignoreClasses=Part,MeshPart</pre>

<h3>ignoreProperties</h3>
<p>Comma-separated list of property names to strip from results.</p>
<pre>GET /asset/6880366374?ignoreProperties=Source,Tags
GET /asset/6880366374?ignoreClasses=Script&amp;ignoreProperties=Source</pre>

<h2>Authentication</h2>
<p>Set ROBLOX_COOKIE env var or pass X-Roblox-Cookie header (if ALLOW_HEADER_COOKIE=true).</p>
<p>Without auth, assets are fetched via RoProxy (public, no auth needed).</p>
</body>
</html>`)
})

app.get("/asset/:id", async (req, res) => {
	try {
		const assetId = parseInt(req.params.id, 10)
		if (!Number.isSafeInteger(assetId) || assetId <= 0) return res.status(400).json({ error: "Invalid asset ID" })
		const cookie = getCookie(req)
		console.log(`Fetching asset ${assetId}...`)
		const { buffer, assetTypeId } = await fetchAsset(assetId, cookie)
		console.log(`Parsing asset ${assetId} (type: ${assetTypeId})...`)
		const parser = RBXModelParser.parse(buffer)
		const instances = parser.result.map(inst => instanceToJSON(inst))
		const ignoreSet = parseList(req.query.ignoreClasses)
		const ignoreProps = parseList(req.query.ignoreProperties)
		const filtered = stripProperties(filterInstances(instances, ignoreSet), ignoreProps)
		res.setHeader("Content-Type", "application/json")
		res.send(JSON.stringify({
			assetId, assetTypeId, meta: parser.meta,
			instanceCount: ignoreSet.size > 0 ? countInstances(instances) - countFiltered(instances, ignoreSet) : countInstances(instances),
			instances: filtered
		}, jsonReplacer))
	} catch (err) {
		console.error(`Error fetching asset ${req.params.id}:`, err.message)
		res.status(500).json({ error: err.message })
	}
})

app.get("/asset/:id/tree", async (req, res) => {
	try {
		const assetId = parseInt(req.params.id, 10)
		if (!Number.isSafeInteger(assetId) || assetId <= 0) return res.status(400).json({ error: "Invalid asset ID" })
		const cookie = getCookie(req)
		console.log(`Fetching asset ${assetId}...`)
		const { buffer, assetTypeId } = await fetchAsset(assetId, cookie)
		console.log(`Parsing asset ${assetId} (type: ${assetTypeId})...`)
		const parser = RBXModelParser.parse(buffer)
		const ignoreSet = parseList(req.query.ignoreClasses)
		const ignoreProps = parseList(req.query.ignoreProperties)
		const tree = []
		flattenInstances(parser.result, tree, "", ignoreSet)
		res.setHeader("Content-Type", "application/json")
		res.send(JSON.stringify({ assetId, assetTypeId, totalInstances: tree.length, instances: stripProperties(tree, ignoreProps) }, jsonReplacer))
	} catch (err) {
		console.error(`Error fetching asset ${req.params.id}:`, err.message)
		res.status(500).json({ error: err.message })
	}
})

app.get("/asset/:id/search", async (req, res) => {
	try {
		const assetId = parseInt(req.params.id, 10)
		const className = req.query.class
		const propName = req.query.prop
		const propValue = req.query.value
		if (!Number.isSafeInteger(assetId) || assetId <= 0) return res.status(400).json({ error: "Invalid asset ID" })
		const cookie = getCookie(req)
		console.log(`Fetching asset ${assetId}...`)
		const { buffer, assetTypeId } = await fetchAsset(assetId, cookie)
		console.log(`Parsing asset ${assetId} (type: ${assetTypeId})...`)
		const parser = RBXModelParser.parse(buffer)
		const ignoreSet = parseList(req.query.ignoreClasses)
		const ignoreProps = parseList(req.query.ignoreProperties)
		let results = []
		function searchInstances(instances, path) {
			for (const inst of instances) {
				const currentPath = path ? `${path}/${inst.getProperty("Name")}` : inst.getProperty("Name")
				const instClassName = inst.getProperty("ClassName")
				if (ignoreSet.has(instClassName)) continue
				let matches = true
				if (className && instClassName !== className) matches = false
				if (propName && inst.getProperty(propName) === undefined) matches = false
				if (propValue && String(inst.getProperty(propName)) !== propValue) matches = false
				if (matches && (className || propName)) {
					results.push(stripProperties([{ path: currentPath, ...instanceToJSON(inst) }], ignoreProps)[0])
				}
				if (inst.Children && inst.Children.length > 0) searchInstances(inst.Children, currentPath)
			}
		}
		searchInstances(parser.result, "")
		res.setHeader("Content-Type", "application/json")
		res.send(JSON.stringify({ assetId, assetTypeId, query: { class: className, prop: propName, value: propValue }, resultCount: results.length, results }, jsonReplacer))
	} catch (err) {
		console.error(`Error fetching asset ${req.params.id}:`, err.message)
		res.status(500).json({ error: err.message })
	}
})

app.get("/asset/:id/class/:className", async (req, res) => {
	try {
		const assetId = parseInt(req.params.id, 10)
		const className = req.params.className
		if (!Number.isSafeInteger(assetId) || assetId <= 0) return res.status(400).json({ error: "Invalid asset ID" })
		const cookie = getCookie(req)
		console.log(`Fetching asset ${assetId}...`)
		const { buffer, assetTypeId } = await fetchAsset(assetId, cookie)
		console.log(`Parsing asset ${assetId} (type: ${assetTypeId})...`)
		const parser = RBXModelParser.parse(buffer)
		const ignoreSet = parseList(req.query.ignoreClasses)
		const ignoreProps = parseList(req.query.ignoreProperties)
		const results = []
		function findByClass(instances, path) {
			for (const inst of instances) {
				const currentPath = path ? `${path}/${inst.getProperty("Name")}` : inst.getProperty("Name")
				if (ignoreSet.has(inst.getProperty("ClassName"))) continue
				if (inst.getProperty("ClassName") === className) {
					results.push(stripProperties([{ path: currentPath, ...instanceToJSON(inst) }], ignoreProps)[0])
				}
				if (inst.Children && inst.Children.length > 0) findByClass(inst.Children, currentPath)
			}
		}
		findByClass(parser.result, "")
		res.setHeader("Content-Type", "application/json")
		res.send(JSON.stringify({ assetId, assetTypeId, className, resultCount: results.length, results }, jsonReplacer))
	} catch (err) {
		console.error(`Error fetching asset ${req.params.id}:`, err.message)
		res.status(500).json({ error: err.message })
	}
})

app.get("/asset/:id/raw", async (req, res) => {
	try {
		const assetId = parseInt(req.params.id, 10)
		if (!Number.isSafeInteger(assetId) || assetId <= 0) return res.status(400).json({ error: "Invalid asset ID" })
		const cookie = getCookie(req)
		console.log(`Fetching raw asset ${assetId}...`)
		const { buffer } = await fetchAsset(assetId, cookie)
		const isXML = buffer.length > 7 && buffer[0] === 0x3C && buffer[1] === 0x72
		let content, contentType
		if (isXML) {
			content = bufferToString(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength))
			contentType = "text/plain; charset=utf-8"
		} else {
			content = buffer.toString("base64")
			contentType = "text/plain; charset=utf-8"
		}
		res.setHeader("Content-Type", contentType)
		res.send(content)
	} catch (err) {
		console.error(`Error fetching raw asset ${req.params.id}:`, err.message)
		res.status(500).json({ error: err.message })
	}
})

app.get("/health", (req, res) => {
	const cookie = process.env.ROBLOX_COOKIE
	res.json({
		status: "ok",
		cookieLoaded: !!cookie,
		headerCookieEnabled: process.env.ALLOW_HEADER_COOKIE === "true",
		cacheEntries: assetCache.size,
		timestamp: new Date().toISOString()
	})
})

app.listen(PORT, HOST, () => {
	console.log(`RBXM Asset Server running on http://${HOST}:${PORT}`)
	console.log(`\nEndpoints:`)
	console.log(`  GET /                             - API docs`)
	console.log(`  GET /asset/:id                    - Parse asset (nested)`)
	console.log(`  GET /asset/:id/tree               - Parse asset (flat)`)
	console.log(`  GET /asset/:id/search?class=X     - Search by class`)
	console.log(`  GET /asset/:id/class/:className   - Get class instances`)
	console.log(`  GET /asset/:id/raw                - Raw asset buffer`)
	console.log(`  GET /health                       - Health check`)
})
