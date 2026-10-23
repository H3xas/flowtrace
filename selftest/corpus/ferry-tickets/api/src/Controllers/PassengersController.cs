using Ferry.Api.Passengers;

namespace Ferry.Api.Controllers;

[Route("passengers")]
public class PassengersController : ControllerBase
{
    private readonly PassengerService _passengers;

    public PassengersController(PassengerService passengers)
    {
        _passengers = passengers;
    }

    [HttpGet("{id}/voyage")]
    public IActionResult Voyage(int id)
    {
        return Ok(_passengers.Lookup(id));
    }

    [HttpGet("{id}/label")]
    public IActionResult Label(int id)
    {
        return Ok(_passengers.Label(new Passenger()));
    }

    [HttpGet("{id}/price")]
    public IActionResult Price(int id)
    {
        return Ok(_passengers.Price(id));
    }

    [HttpGet("{id}/badge")]
    public IActionResult Badge(int id)
    {
        return Ok(_passengers.Badge(new Passenger()));
    }

    [HttpGet("{id}/ticket")]
    public IActionResult Ticket(int id)
    {
        return Ok(_passengers.Ticket(new Passenger()));
    }

    [HttpGet("{id}/receipt")]
    public IActionResult Receipt(int id)
    {
        return Ok(_passengers.Receipt(new Passenger()));
    }

    [HttpGet("{id}/summary")]
    public async Task<IActionResult> Summary(int id)
    {
        return Ok(await _passengers.Summarize(id));
    }

    [HttpPost("{id}/board")]
    public IActionResult Board(int id)
    {
        _passengers.Board(id, null);
        return Ok();
    }
}
