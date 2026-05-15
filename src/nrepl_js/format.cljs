(ns nrepl-js.format
  (:require [promesa.core :as p]
            [nrepl-js.cdp-interop :as cdp]))

(declare parse-result)

(defn- preview->string [^js prev]
  (let [props (array-seq (.-properties prev))
        overflow (if (.-overflow prev) ", …" "")]
    (if (= (.-subtype prev) "array")
      (let [items (map (fn [^js p]
                         (let [t (.-type p) v (.-value p)]
                           (cond
                             (= t "string") (js/JSON.stringify v)
                             (= t "object") (or v "[object]")
                             :else (str (or v ""))))) props)]
        (str "[ " (.join (into-array items) ", ") overflow " ]"))
      (let [items (map (fn [^js pp]
                         (let [t (.-type pp) v (.-value pp)
                               val (cond
                                     (= t "string") (js/JSON.stringify v)
                                     (= t "object") (or v "[object]")
                                     :else (str (or v "")))]
                           (str (.-name pp) ": " val))) props)
            desc (let [d (.-description prev)]
                   (if (and d (not= d "Object")) (str d " ") ""))]
        (str desc "{ " (.join (into-array items) ", ") overflow " }")))))

(defn format-remote-object [^js ro]
  (cond
    (not ro) ""
    (.-unserializableValue ro) (str (.-unserializableValue ro))
    (= (.-type ro) "undefined") "undefined"
    (= (.-type ro) "string") (.-value ro)
    (= (.-type ro) "number") (str (.-value ro))
    (= (.-type ro) "boolean") (str (.-value ro))
    (= (.-type ro) "bigint") (str (.-value ro))
    (= (.-type ro) "symbol") (or (.-description ro) "Symbol()")
    (= (.-type ro) "function") (or (.-description ro) "[Function]")
    (= (.-subtype ro) "null") "null"
    (.-preview ro) (preview->string (.-preview ro))
    (.-description ro) (.-description ro)
    :else "[object]"))

(defn format-exception [^js ed]
  (when ed
    (let [^js exc (.-exception ed)]
      (if exc
        (or (.-description exc) (.-value exc) (.-text ed) "Error")
        (or (.-text ed) "Error")))))

(declare parse-result)
(defn- ^:async parse-kv [cdp i depth]
  #js [#js["literal" (:name i)]
       (await (parse-result cdp (:value i) (inc depth)))])

(defn ^:async parse-result
  ([cdp result] (parse-result cdp result 0))
  ([^js cdp ^js result depth]
   (when result
     (case (:type result)
       "undefined"
       #js ["literal" "undefined"]

       ("string" "number" "boolean")
       #js [(:type result) (:description result (:value result))]

       "object"
       (if (= (:subtype result) "null")
         #js ["literal" "null"]
         (if (< depth 10)
           (let [res (await (cdp/call cdp
                                      "Runtime.getProperties"
                                      (assoc result :ownProperties true)))]
             (if (= (:subtype result) "array")
               #js ["coll"
                    (if (= (:className result) "Array") "" (str "Object [" (:className result) "] "))
                    "[" ", " "]"
                    (->> (:result res)
                         (filter #(re-find #"^\d+$" (:name ^js %)))
                         (map #(parse-result cdp (:value ^js %) (inc depth)))
                         p/all
                         await
                         into-array)]
               #js ["map"
                    (if (= (:className result) "Object") "" (str "[object " (:className result) "] "))
                    "{" ": " ", " "}"
                    (->> (:result res)
                         (filter #(string? (:name ^js %)))
                         (map #(parse-kv cdp % depth))
                         p/all
                         await
                         into-array)]))
           (if (= (:className result) "Object")
             #js ["..." "[object]" (:objectId result)]
             #js ["..." (str (:className result) " {...}") (:objectId result)])))

       (= t "function")
       (if (= (:className result) "Function")
         (let [descr (let [desc (:description result)
                           m (when desc (re-find #"(class|function) ([^\s\(]+)" desc))]
                       (cond
                         m (str "[" (first m) "]")
                         (and desc (.includes desc "[native code]")) "[native function]"
                         :else "[function]"))]
           #js ["literal" descr])
         #js ["literal" (:className result)])

       :else
       #js ["literal" (or (:description result) (:value result))]))))
