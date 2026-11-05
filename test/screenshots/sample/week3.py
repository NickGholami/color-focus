import numpy as np
import matplotlib.pyplot as plt


def load_data(path):
    """Read the measurements from a CSV file."""
    data = np.loadtxt(path, delimiter=",", skiprows=1)
    return data[:, 0], data[:, 1]


# Exercise 1: fit a straight line
def fit_line(x, y):
    A = np.vstack([x, np.ones_like(x)]).T
    slope, intercept = np.linalg.lstsq(A, y, rcond=None)[0]
    return slope, intercept


def plot_fit(x, y, slope, intercept):
    plt.scatter(x, y, s=10, label="data")
    plt.plot(x, slope * x + intercept, "r", label="fit")
    plt.legend()
    plt.show()


# Exercise 2: residuals and error
def residuals(x, y, slope, intercept):
    return y - (slope * x + intercept)


def rms_error(r):
    return np.sqrt(np.mean(r ** 2))


if __name__ == "__main__":
    x, y = load_data("measurements.csv")
    slope, intercept = fit_line(x, y)
    r = residuals(x, y, slope, intercept)
    print(f"slope={slope:.3f}  rms={rms_error(r):.3f}")
    plot_fit(x, y, slope, intercept)
