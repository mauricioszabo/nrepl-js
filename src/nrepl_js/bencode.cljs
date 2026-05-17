(ns nrepl-js.bencode)

(def ^:private COLON 0x3a)
(def ^:private E     0x65)
(def ^:private I     0x69)
(def ^:private L     0x6c)
(def ^:private D     0x64)
(def ^:private ZERO  0x30)
(def ^:private NINE  0x39)
(def ^:private MINUS 0x2d)

(defn- need-more! []
  (let [e (js/Error. "need more bytes")]
    (set! (.-code e) "NEED_MORE")
    (throw e)))

(defn- need [buf offset n]
  (when (> (+ offset n) (.-length buf))
    (need-more!)))

(declare dec-val)

(defn- dec-int [buf offset]
  (let [i (atom (inc offset))]
    (need buf @i 1)
    (let [neg (atom false)]
      (when (= (aget buf @i) MINUS)
        (reset! neg true)
        (swap! i inc))
      (let [n (atom 0)
            any (atom false)]
        (loop []
          (need buf @i 1)
          (let [b (aget buf @i)]
            (if (= b E)
              [((if @neg - identity) @n) (inc @i)]
              (do
                (when (or (< b ZERO) (> b NINE))
                  (throw (js/Error. (str "bencode: bad int digit at " @i))))
                (reset! n (+ (* @n 10) (- b ZERO)))
                (reset! any true)
                (swap! i inc)
                (recur)))))))))

(defn- dec-bytes [buf offset]
  (let [i (atom offset)
        len (atom 0)]
    (loop []
      (need buf @i 1)
      (let [b (aget buf @i)]
        (if (= b COLON)
          (let [start (inc @i)]
            (need buf start @len)
            [(.toString (.subarray buf start (+ start @len)) "utf8") (+ start @len)])
          (do
            (when (or (< b ZERO) (> b NINE))
              (throw (js/Error. (str "bencode: bad length digit at " @i))))
            (swap! len #(+ (* % 10) (- b ZERO)))
            (swap! i inc)
            (recur)))))))

(defn- dec-list [buf offset]
  (let [i (atom (inc offset))
        out (array)]
    (loop []
      (need buf @i 1)
      (if (= (aget buf @i) E)
        [out (inc @i)]
        (let [[v ni] (dec-val buf @i)]
          (.push out v)
          (reset! i ni)
          (recur))))))

(defn- dec-dict [buf offset]
  (let [i (atom (inc offset))
        out (js-obj)]
    (loop []
      (need buf @i 1)
      (if (= (aget buf @i) E)
        [out (inc @i)]
        (let [[k ki] (dec-bytes buf @i)
              [v vi] (dec-val buf ki)]
          (aset out k v)
          (reset! i vi)
          (recur))))))

(defn- dec-val [buf offset]
  (need buf offset 1)
  (let [b (aget buf offset)]
    (cond
      (= b I) (dec-int buf offset)
      (= b L) (dec-list buf offset)
      (= b D) (dec-dict buf offset)
      (and (>= b ZERO) (<= b NINE)) (dec-bytes buf offset)
      :else (throw (js/Error. (str "bencode: unexpected byte 0x" (.toString b 16) " at " offset))))))

(defn- enc [v out]
  (cond
    (number? v)
    (do
      (when-not (js/Number.isInteger v)
        (throw (js/TypeError. (str "bencode: only integers, got " v))))
      (.push out (js/Buffer.from (str "i" v "e"))))

    (string? v)
    (let [buf (js/Buffer.from v "utf8")]
      (.push out (js/Buffer.from (str (.-length buf) ":")))
      (.push out buf))

    (js/Buffer.isBuffer v)
    (do
      (.push out (js/Buffer.from (str (.-length v) ":")))
      (.push out v))

    (array? v)
    (do
      (.push out (js/Buffer.from "l"))
      (doseq [item v] (enc item out))
      (.push out (js/Buffer.from "e")))

    (and v (object? v))
    (do
      (.push out (js/Buffer.from "d"))
      (let [keys (->> (js/Object.keys v)
                      (filter #(not (undefined? (aget v %))))
                      sort)]
        (doseq [k keys]
          (enc k out)
          (enc (aget v k) out)))
      (.push out (js/Buffer.from "e")))

    :else
    (throw (js/TypeError. (str "bencode: unsupported value: " (js/Object.prototype.toString.call v))))))

(defn encode [value]
  (let [parts (array)]
    (enc value parts)
    (js/Buffer.concat parts)))

(defn decode [buf]
  (try
    (let [[value offset] (dec-val buf 0)]
      {:value value :rest (.subarray buf offset)})
    (catch :default e
      (if (= (.-code e) "NEED_MORE")
        nil
        (throw e)))))
