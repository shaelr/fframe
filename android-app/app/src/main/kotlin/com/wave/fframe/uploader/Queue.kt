package com.wave.fframe.uploader

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/**
 * Fila de envio. Guarda dois tipos de item:
 *  - PROXY: gera a versao leve no aparelho e envia (uso normal)
 *  - ORIGINAL: envia o arquivo original, sem transcodificar (para render final)
 * Cada item guarda o projeto de destino escolhido na hora.
 */
object Queue {

    const val KIND_PROXY = "proxy"
    const val KIND_ORIGINAL = "original"

    data class Item(
        val uri: String,
        val name: String,
        val projectId: String,
        val projectName: String,
        val quality: String,
        val kind: String = KIND_PROXY
    )

    private fun sp(ctx: Context) = ctx.getSharedPreferences("fframe_queue", Context.MODE_PRIVATE)

    fun all(ctx: Context): List<Item> {
        val raw = sp(ctx).getString("items", "[]")!!
        return try {
            val arr = JSONArray(raw)
            (0 until arr.length()).map {
                val o = arr.getJSONObject(it)
                Item(o.getString("uri"), o.getString("name"), o.optString("projectId", ""),
                    o.optString("projectName", ""), o.optString("quality", Prefs.PROXY_720),
                    o.optString("kind", KIND_PROXY))
            }
        } catch (e: Exception) { emptyList() }
    }

    fun of(ctx: Context, kind: String) = all(ctx).filter { it.kind == kind }

    fun count(ctx: Context) = all(ctx).size

    fun add(ctx: Context, item: Item) {
        val list = all(ctx).toMutableList()
        // um mesmo video pode estar na fila como proxy E como original
        if (list.none { it.uri == item.uri && it.kind == item.kind }) list.add(item)
        save(ctx, list)
    }

    fun remove(ctx: Context, uri: String, kind: String) =
        save(ctx, all(ctx).filter { !(it.uri == uri && it.kind == kind) })

    fun clear(ctx: Context, kind: String? = null) =
        save(ctx, if (kind == null) emptyList() else all(ctx).filter { it.kind != kind })

    private fun save(ctx: Context, list: List<Item>) {
        val arr = JSONArray()
        list.forEach {
            arr.put(JSONObject().put("uri", it.uri).put("name", it.name)
                .put("projectId", it.projectId).put("projectName", it.projectName)
                .put("quality", it.quality).put("kind", it.kind))
        }
        sp(ctx).edit().putString("items", arr.toString()).apply()
    }
}
