program matrix_demo
  implicit none
  integer, parameter :: n = 3
  real :: a(n, n), b(n), x(n)
  integer :: i

  ! Exercise 1: build the system
  a = reshape([4.0, 1.0, 0.0, &
               1.0, 4.0, 1.0, &
               0.0, 1.0, 4.0], [n, n])
  b = [1.0, 2.0, 3.0]

  ! Exercise 2: Jacobi iteration
  x = 0.0
  do i = 1, 50
    x = (b - matmul(a, x) + diag(a) * x) / diag(a)
  end do

  print *, "x =", x

contains

  function diag(m) result(d)
    real, intent(in) :: m(:, :)
    real :: d(size(m, 1))
    integer :: k
    do k = 1, size(m, 1)
      d(k) = m(k, k)
    end do
  end function diag

end program matrix_demo
