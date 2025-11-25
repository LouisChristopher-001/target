import axios from "axios";

const api = axios.create({
  baseURL: "https://target-5k2w.onrender.com" // your backend URL
});

export default api;
