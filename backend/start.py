from uvicorn import run

if __name__ == "__main__":
    run("main:api", host="localhost", port=8000)