from uvicorn import run

if __name__ == "__main__":
    run("main:api", host="0.0.0.0", port=8000)