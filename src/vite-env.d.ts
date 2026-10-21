/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Google Maps JS APIのキー（viteがビルド時に値へ差し替え。リポジトリの既定は空＝キーが無い環境は置き換え絵のまま。値はGit・docsに載せない。V05） */
  readonly VITE_GOOGLE_MAPS_API_KEY?: string;
}
