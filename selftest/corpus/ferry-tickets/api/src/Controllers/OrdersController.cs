using Ferry.Api.Routes;
using Ferry.Api.Services;

namespace Ferry.Api.Controllers;

[ApiController]
[Route(ApiRoutes.Base)]
public class OrdersController : ControllerBase
{
    private readonly BookingService _booking;

    public OrdersController(BookingService booking)
    {
        _booking = booking;
    }

    [HttpPost("orders")]
    public IActionResult PlaceOrder(OrderRequest request)
    {
        return Ok(_booking.Place(request));
    }
}
