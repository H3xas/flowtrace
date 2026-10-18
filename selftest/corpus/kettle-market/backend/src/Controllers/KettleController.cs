using Microsoft.AspNetCore.Mvc;

namespace KettleMarket.Api.Controllers
{
    [ApiController]
    [Route("market/v1")]
    public class KettleController : ControllerBase
    {
        [HttpGet("prices")]
        public IActionResult GetPrices()
        {
            return Ok();
        }

        [HttpGet("stock")]
        public IActionResult GetStock()
        {
            return Ok();
        }

        [HttpGet("basket")]
        public IActionResult GetBasket()
        {
            return Ok();
        }

        [HttpGet("banner")]
        public IActionResult GetBanner()
        {
            return Ok();
        }

        [HttpPost("orders")]
        public IActionResult PlaceOrder()
        {
            return Ok();
        }
    }
}
